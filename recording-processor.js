import dotenv from 'dotenv';
import axios from 'axios';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

dotenv.config();

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Handle SECRET_TOKEN for webhook secret
if (process.env.SECRET_TOKEN && !process.env.WEBHOOK_SECRET) {
    process.env.WEBHOOK_SECRET = process.env.SECRET_TOKEN;
}

// ADD THIS CODE BLOCK HERE - This decodes the key when the app starts
if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64) {
    const keyJson = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64, 'base64').toString();
    fs.writeFileSync('./service-account-key.json', keyJson);
    console.log('✓ Service account key decoded');
}


class RecordingProcessor {
    constructor() {
        // Zoom credentials
        this.zoomAccountId = process.env.ZOOM_ACCOUNT_ID;
        this.zoomClientId = process.env.ZOOM_CLIENT_ID;
        this.zoomClientSecret = process.env.ZOOM_CLIENT_SECRET;
        
        // Google credentials
        this.driveRootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
        this.mappingsSheetId = process.env.MAPPINGS_SHEET_ID;
        
        // Caches
        this.studentMappings = new Map();
        this.folderCache = new Map();
        this.tokenCache = { token: null, expires: 0 };
        
        // Known coach names from ConvertNames.py
        this.knownCoachNames = new Set([
            'noor', 'jenny', 'aditi', 'marissa', 'rishi', 'erin',
            'janice', 'summer', 'jamie', 'alice', 'alan', 'andrew', 'juli'
        ]);
        
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;
        
        console.log('Initializing Recording Processor...');
        
        // Check if we should use impersonation
        const impersonatedUser = process.env.GOOGLE_IMPERSONATED_USER;
        
        if (impersonatedUser) {
            console.log(`Using domain-wide delegation to impersonate: ${impersonatedUser}`);
            
            // Read the service account key
            let key;
            if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64) {
                const keyJson = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64, 'base64').toString();
                key = JSON.parse(keyJson);
                // Also write it for compatibility
                fs.writeFileSync('./service-account-key.json', keyJson);
            } else {
                const keyContent = fs.readFileSync('./service-account-key.json', 'utf8');
                key = JSON.parse(keyContent);
            }
            
            // Create JWT client with subject (impersonation)
            const authClient = new JWT({
                email: key.client_email,
                key: key.private_key,
                scopes: [
                    'https://www.googleapis.com/auth/drive',
                    'https://www.googleapis.com/auth/spreadsheets'
                ],
                subject: impersonatedUser // This enables impersonation
            });
            
            await authClient.authorize();
            
            this.drive = google.drive({ version: 'v3', auth: authClient });
            this.sheets = google.sheets({ version: 'v4', auth: authClient });
            
        } else {
            // Fallback to regular service account auth (without impersonation)
            console.log('Using regular service account authentication (15GB limit)');
            
            const auth = new google.auth.GoogleAuth({
                keyFile: './service-account-key.json',
                scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']
            });

            const authClient = await auth.getClient();
            this.drive = google.drive({ version: 'v3', auth: authClient });
            this.sheets = google.sheets({ version: 'v4', auth: authClient });
        }
        
        // Check storage quota
        try {
            const about = await this.drive.about.get({
                fields: 'storageQuota, user'
            });
            
            console.log(`\n📊 Drive Storage Info:`);
            console.log(`   Authenticated as: ${about.data.user.emailAddress}`);
            
            const quota = about.data.storageQuota;
            if (quota.limit && quota.limit !== '-1') {
                const usedGB = (parseInt(quota.usage) / 1073741824).toFixed(2);
                const limitGB = (parseInt(quota.limit) / 1073741824).toFixed(2);
                console.log(`   Storage: ${usedGB} GB / ${limitGB} GB used`);
                
                if (parseInt(quota.usage) >= parseInt(quota.limit) * 0.9) {
                    console.warn(`   ⚠️  WARNING: Storage is ${((parseInt(quota.usage) / parseInt(quota.limit)) * 100).toFixed(1)}% full!`);
                }
            } else {
                console.log(`   Storage: Using organization pool (22TB available)`);
            }
        } catch (error) {
            console.warn('   Could not check storage quota:', error.message);
        }
        
        // Load data
        await this.loadStudentMappings();
        await this.ensureFolderStructure();
        
        this.initialized = true;
        console.log('✓ Recording Processor initialized');
    }

    async loadStudentMappings() {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.mappingsSheetId,
                range: 'Mappings!A2:F'
            });

            const rows = response.data.values || [];
            this.studentMappings.clear();
            
            rows.forEach(row => {
                const [studentEmail, studentName, coachEmail, coachName, program, startDate] = row;
                if (studentEmail) {
                    this.studentMappings.set(studentEmail.toLowerCase().trim(), {
                        name: studentName || 'Unknown Student',
                        coach: coachName || 'Unknown Coach',
                        coachEmail: coachEmail || '',
                        program: program || 'Unknown Program',
                        startDate: startDate || new Date().toISOString().split('T')[0]
                    });
                }
            });

            console.log(`✓ Loaded ${this.studentMappings.size} student mappings`);
        } catch (error) {
            console.error('Error loading mappings:', error.message);
            throw error;
        }
    }

    async ensureFolderStructure() {
        const mainFolders = ['By Program', 'By Coach', 'By Student', 'Master Database', 'TEMP_ZOOM_RECORDINGS'];
        
        for (const folderName of mainFolders) {
            const folderId = await this.getOrCreateFolder(this.driveRootFolderId, folderName);
            this.folderCache.set(folderName, folderId);
        }
        
        console.log('✓ Folder structure verified');
    }

    async getZoomToken() {
        // Return cached token if still valid
        if (this.tokenCache.token && Date.now() < this.tokenCache.expires) {
            return this.tokenCache.token;
        }

        const authString = Buffer.from(`${this.zoomClientId}:${this.zoomClientSecret}`).toString('base64');
        
        const response = await axios.post(
            'https://zoom.us/oauth/token',
            `grant_type=account_credentials&account_id=${this.zoomAccountId}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${authString}`
                }
            }
        );

        // Cache the token
        this.tokenCache = {
            token: response.data.access_token,
            expires: Date.now() + (response.data.expires_in - 60) * 1000
        };

        return this.tokenCache.token;
    }

    extractCoachFromRecordingInfo(topic, hostEmail, participantInfo = null) {
        const topicLower = topic.toLowerCase();
        
        // First check if it's a Siraj recording
        if (this.isSirajRecording(topic)) {
            return "Siraj";
        }
        
        // Split topic into parts for pattern matching
        const parts = topic.split('_');
        
        // Check if first part is a known coach name (highest confidence)
        if (parts.length >= 2 && this.knownCoachNames.has(parts[0].toLowerCase())) {
            return this.capitalizeWord(parts[0]);
        }
        
        // Enhanced coach patterns
        const coachPatterns = [
            /coach[_\s]+([a-z]+)/i,
            /new[_\s]+coach[_\s]+([a-z]+)/i,
            /coach[_\s]*[:]\s*([a-z]+)/i,
            /w[_\s]*(?:ith)?[_\s]*([a-z]+)/i,
            /coach[_\s]*([a-z]+)(?:[_\s]+(?:week|wk|session))?/i,
            /([a-z]+)[_\s]*(?:coaching|session|meeting)/i,
            /with[_\s]+coach[_\s]+([a-z]+)/i,
            /([a-z]+)[_\s]*-[_\s]*coach/i
        ];
        
        for (const pattern of coachPatterns) {
            const match = topicLower.match(pattern);
            if (match) {
                const potentialCoach = match[1].toLowerCase();
                if (this.knownCoachNames.has(potentialCoach)) {
                    return this.capitalizeWord(match[1]);
                }
            }
        }
        
        // Pattern 2: Look for known coach names in any position
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i].toLowerCase();
            if (this.knownCoachNames.has(part)) {
                return this.capitalizeWord(parts[i]);
            }
        }
        
        // Pattern 3: Look for known coach names in topic
        const words = topicLower.split(/[_\s\-]+/);
        for (const word of words) {
            const cleanWord = word.replace(/[^a-z]/g, '');
            if (this.knownCoachNames.has(cleanWord)) {
                return this.capitalizeWord(cleanWord);
            }
        }
        
        // Pattern 4: Check host email
        if (hostEmail && this.isCoachEmail(hostEmail)) {
            const emailName = hostEmail.split('@')[0];
            const firstName = emailName.split('.')[0];
            if (this.knownCoachNames.has(firstName.toLowerCase())) {
                return this.capitalizeWord(firstName);
            }
        }
        
        // Pattern 5: Check participant info if available
        if (participantInfo && Array.isArray(participantInfo)) {
            for (const participant of participantInfo) {
                if (participant.email && this.isCoachEmail(participant.email)) {
                    const emailName = participant.email.split('@')[0];
                    const firstName = emailName.split('.')[0];
                    if (this.knownCoachNames.has(firstName.toLowerCase())) {
                        return this.capitalizeWord(firstName);
                    }
                }
            }
        }
        
        return null;
    }

    extractStudentFromRecordingInfo(topic, coach = null) {
        // Split topic into parts for better pattern matching
        const parts = topic.split('_');
        
        // If we have a coach and it's at position 0, look for student after
        if (coach && parts.length >= 3 && parts[0].toLowerCase() === coach.toLowerCase()) {
            // Remove coach part and any numeric parts
            const remainingParts = parts.slice(1).filter(part => !part.match(/^\d+$/));
            
            if (remainingParts.length >= 2) {
                // Check for hyphenated last names
                const hyphenatedIndex = remainingParts.findIndex(part => part.includes('-'));
                
                if (hyphenatedIndex > 0) {
                    const firstName = remainingParts[hyphenatedIndex - 1];
                    const lastName = remainingParts[hyphenatedIndex];
                    
                    // Filter out company names
                    const fullName = `${this.capitalizeWord(firstName)} ${this.capitalizeWord(lastName)}`;
                    if (!this.isCompanyName(fullName)) {
                        return fullName;
                    }
                } else if (remainingParts.length === 2) {
                    const fullName = `${this.capitalizeWord(remainingParts[0])} ${this.capitalizeWord(remainingParts[1])}`;
                    if (!this.isCompanyName(fullName)) {
                        return fullName;
                    }
                }
            }
        }
        
        // Enhanced student patterns
        const patterns = [
            /____([a-z]+)___/i,
            /___([a-z]+(?:_[a-z]+)*)___/i,
            /__([a-z]+(?:_[a-z]+)*)__/i,
            /student[_\s]+([a-z]+(?:_[a-z]+)*)/i,
            /student[_\s]*[:_-]?\s*([a-z]+(?:[_\s]+[a-z]+)?)/i,
            /([a-z]+(?:[_\s]+[a-z]+)?)[_\s]*(?:week|wk|session)/i,
            /meeting[_\s]+with[_\s]+([a-z]+(?:[_\s]+[a-z]+)?)/i,
            /([a-z]+(?:[_\s]+[a-z]+)?)[_\s]*x[_\s]*([a-z]+)/i
        ];
        
        for (const pattern of patterns) {
            const match = topic.match(pattern);
            if (match) {
                const studentName = match[1];
                if (!coach || studentName.toLowerCase() !== coach.toLowerCase()) {
                    const formattedName = studentName.split('_').map(w => this.capitalizeWord(w)).join(' ');
                    if (!this.isCompanyName(formattedName)) {
                        return formattedName;
                    }
                }
            }
        }
        
        // Fallback: Look for name after coach name
        if (coach) {
            const coachEscaped = coach.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(`${coachEscaped}[_\\s]*_{2,}[_\\s]*([a-z]+(?:aa)?)`, 'i');
            const match = topic.match(pattern);
            if (match) {
                const studentName = match[1];
                if (!['week', 'wk', 'meeting', 'zoom', 'game', 'plan', 'prep'].includes(studentName.toLowerCase())) {
                    if (!this.isCompanyName(studentName)) {
                        return this.capitalizeWord(studentName);
                    }
                }
            }
        }
        
        return null;
    }

    extractWeekNumber(topic) {
        // Enhanced week patterns
        const weekPatterns = [
            /week[_\s]+(\d+)/i,
            /wk[_\s]+(\d+)/i,
            /week[_\s]*#[_\s]*(\d+)/i,
            /wk[_\s]*#[_\s]*(\d+)/i,
            /w(?:ee)?k\s*[#-]?\s*(\d+)/i,
            /session\s*[#-]?\s*(\d+)/i,
            /meeting\s*[#-]?\s*(\d+)/i,
            /(\d+)(?:st|nd|rd|th)?\s*(?:week|session|meeting)/i,
            /wk(\d+)/i,
            /w(\d+)/i
        ];
        
        for (const pattern of weekPatterns) {
            const match = topic.match(pattern);
            if (match) {
                return match[1];
            }
        }
        
        return null;
    }

    hasGamePlanIndicator(topic) {
        const gamePatterns = [
            /\bgame[_\s]*plan\b/i,
            /\bgameplan\b/i,
            /\bstrategy[_\s]*session\b/i,
            /\bplanning[_\s]*meeting\b/i
        ];
        
        return gamePatterns.some(pattern => pattern.test(topic));
    }

    isCoachEmail(email) {
        if (!email || typeof email !== 'string') return false;
        const emailLower = email.toLowerCase();
        return emailLower.includes('@ivymentors.co') || emailLower.includes('@stanford.edu');
    }

    capitalizeWord(word) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }

    isSirajRecording(topic) {
        return topic.toLowerCase().includes('siraj') && !topic.toLowerCase().includes('sameeha_siraj');
    }
    
    // Enhanced timeline parsing
    parseTimelineForParticipants(timelineData) {
        const result = { 
            coach: null, 
            student: null,
            participants: [],
            confidence: {
                coach: 0,
                student: 0
            }
        };
        const usersFound = new Map();
        
        try {
            // The timeline structure is {"timeline": [{"ts": "...", "users": [...]}, ...]}
            if (timelineData && timelineData.timeline && Array.isArray(timelineData.timeline)) {
                // Collect all unique users from timeline events
                for (const event of timelineData.timeline) {
                    if (event.users && Array.isArray(event.users)) {
                        for (const user of event.users) {
                            if (user && user.username) {
                                const username = user.username;
                                const email = user.email_address || '';
                                const userId = user.zoom_userid || user.user_id || email || username;
                                
                                // Skip if username is just a number or 'Ivylevel'
                                if (username.match(/^\d+$/) || username.toLowerCase() === 'ivylevel') {
                                    continue;
                                }
                                
                                usersFound.set(userId, {
                                    username: username,
                                    email: email,
                                    isCoach: this.isLikelyCoach(username, email)
                                });
                            }
                        }
                    }
                }
                
                // Categorize users
                const coaches = [];
                const students = [];
                
                for (const [userId, userInfo] of usersFound) {
                    result.participants.push(userInfo);
                    
                    if (userInfo.isCoach) {
                        coaches.push(userInfo.username);
                    } else {
                        students.push(userInfo.username);
                    }
                }
                
                // Select primary coach and student
                if (coaches.length > 0) {
                    result.coach = coaches[0];
                    result.confidence.coach = 0.8;
                }
                if (students.length > 0) {
                    result.student = students[0];
                    result.confidence.student = 0.8;
                }
                
                // If no coaches found but multiple users exist, use heuristic
                if (!result.coach && usersFound.size >= 2) {
                    const usersArray = Array.from(usersFound.values());
                    // Find user with coach email
                    const coachUser = usersArray.find(u => u.email && this.isCoachEmail(u.email));
                    if (coachUser) {
                        result.coach = coachUser.username;
                        result.confidence.coach = 0.9;
                        result.student = usersArray.find(u => u.username !== result.coach)?.username;
                        result.confidence.student = 0.7;
                    }
                }
            }
        } catch (error) {
            console.error('Error in parseTimelineForParticipants:', error.message);
        }
        
        return result;
    }
    
// Enhanced timeline parsing with company name filtering
    parseTimelineForParticipantsEnhanced(timelineData) {
        const result = { 
            coach: null, 
            student: null,
            participants: [],
            confidence: {
                coach: 0,
                student: 0
            },
            isIvylevel: false
        };
        const usersFound = new Map();
        
        try {
            if (timelineData && timelineData.timeline && Array.isArray(timelineData.timeline)) {
                let hasOnlyContactEmail = true;
                let hasOtherCoachEmail = false;
                
                // Collect all unique users from timeline events
                for (const event of timelineData.timeline) {
                    if (event.users && Array.isArray(event.users)) {
                        for (const user of event.users) {
                            if (user && user.username) {
                                const username = user.username;
                                const email = user.email_address || '';
                                const userId = user.zoom_userid || user.user_id || email || username;
                                
                                // Skip numeric usernames, 'Ivylevel', or company names
                                if (username.match(/^\d+$/) || 
                                    username.toLowerCase() === 'ivylevel' ||
                                    this.isCompanyName(username)) {
                                    continue;
                                }
                                
                                // Check for contact@ivymentors.co scenario
                                if (email && email.includes('@ivymentors.co')) {
                                    if (email !== 'contact@ivymentors.co') {
                                        hasOtherCoachEmail = true;
                                    }
                                } else if (email) {
                                    hasOnlyContactEmail = false;
                                }
                                
                                usersFound.set(userId, {
                                    username: username,
                                    email: email,
                                    isCoach: this.isLikelyCoach(username, email)
                                });
                            }
                        }
                    }
                }
                
                // Check if only contact@ivymentors.co is present (Ivylevel scenario)
                if (hasOnlyContactEmail && !hasOtherCoachEmail) {
                    result.isIvylevel = true;
                }
                
                // Categorize users
                const coaches = [];
                const students = [];
                
                for (const [userId, userInfo] of usersFound) {
                    result.participants.push(userInfo);
                    
                    if (userInfo.isCoach) {
                        coaches.push(userInfo.username);
                    } else {
                        students.push(userInfo.username);
                    }
                }
                
                // Select primary coach and student
                if (result.isIvylevel) {
                    result.coach = 'Ivylevel';
                    result.confidence.coach = 0.9;
                } else if (coaches.length > 0) {
                    result.coach = coaches[0];
                    result.confidence.coach = 0.9;
                }
                
                if (students.length > 0) {
                    // Filter out company names from students
                    const validStudents = students.filter(s => !this.isCompanyName(s));
                    if (validStudents.length > 0) {
                        result.student = validStudents[0];
                        result.confidence.student = 0.9;
                    }
                }
                
                // If no coaches found but multiple users exist, use heuristic
                if (!result.coach && usersFound.size >= 2) {
                    const usersArray = Array.from(usersFound.values());
                    const coachUser = usersArray.find(u => u.email && this.isCoachEmail(u.email));
                    if (coachUser) {
                        result.coach = coachUser.username;
                        result.confidence.coach = 0.9;
                        const studentUser = usersArray.find(u => u.username !== result.coach && !this.isCompanyName(u.username));
                        if (studentUser) {
                            result.student = studentUser.username;
                            result.confidence.student = 0.7;
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error in parseTimelineForParticipantsEnhanced:', error.message);
        }
        
        return result;
    }

    isLikelyCoach(username, email) {
        if (email && this.isCoachEmail(email)) {
            return true;
        }
        
        if (username) {
            const firstName = username.toLowerCase().split(/[.\s_-]/)[0];
            if (this.knownCoachNames.has(firstName)) {
                return true;
            }
        }
        
        return false;
    }

    // New enhanced methods for transcript analysis
    async analyzeTranscript(transcriptFileId) {
        try {
            console.log('  📝 Analyzing transcript for speaker identification...');
            
            const response = await this.drive.files.get({
                fileId: transcriptFileId,
                alt: 'media'
            });
            
            const vttContent = response.data.toString();
            
            // Parse VTT format
            const speakers = new Map();
            const lines = vttContent.split('\n');
            let currentSpeaker = null;
            let currentText = '';
            
            // Patterns for name extraction
            const nameExtractionPatterns = [
                /(?:I'm|I am|This is|My name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
                /(?:Coach|Professor|Dr\.?)\s+([A-Z][a-z]+)/i,
                /Hi\s+([A-Z][a-z]+),?\s+(?:I'm|this is)/i,
                /([A-Z][a-z]+)\s+speaking/i,
                /call me\s+([A-Z][a-z]+)/i
            ];
            
            // Role identification patterns
            const coachPatterns = [
                /(?:your coach|I'll be coaching|as your coach|I'm the coach)/i,
                /(?:let me coach|coaching session|coach for)/i,
                /(?:I'll guide you|I'll help you with|let's work on)/i,
                /(?:assignment|homework|practice|review|feedback)/i
            ];
            
            const studentPatterns = [
                /(?:my coach|you're my coach|thanks coach)/i,
                /(?:I need help with|I'm struggling with|can you help)/i,
                /(?:I'm a student|I'm taking|I'm enrolled)/i,
                /(?:question|help|confused|understand|struggling)/i
            ];
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                
                // Check if this is a speaker line
                if (line.includes(':') && !line.includes('-->')) {
                    const colonIndex = line.indexOf(':');
                    const possibleSpeaker = line.substring(0, colonIndex).trim();
                    
                    // Check if this looks like a speaker label
                    if (possibleSpeaker.match(/^(Speaker\s*\d+|[A-Za-z\s]+)$/)) {
                        currentSpeaker = possibleSpeaker;
                        currentText = line.substring(colonIndex + 1).trim();
                        
                        if (!speakers.has(currentSpeaker)) {
                            speakers.set(currentSpeaker, {
                                label: currentSpeaker,
                                possibleNames: new Set(),
                                messageCount: 0,
                                identifiedRole: null,
                                textSamples: []
                            });
                        }
                        
                        const speakerData = speakers.get(currentSpeaker);
                        speakerData.messageCount++;
                        speakerData.textSamples.push(currentText);
                        
                        // Try to extract names
                        for (const pattern of nameExtractionPatterns) {
                            const nameMatch = currentText.match(pattern);
                            if (nameMatch) {
                                speakerData.possibleNames.add(nameMatch[1]);
                            }
                        }
                        
                        // Identify role
                        for (const pattern of coachPatterns) {
                            if (currentText.match(pattern)) {
                                speakerData.identifiedRole = 'coach';
                                break;
                            }
                        }
                        
                        for (const pattern of studentPatterns) {
                            if (currentText.match(pattern)) {
                                speakerData.identifiedRole = 'student';
                                break;
                            }
                        }
                    }
                }
            }
            
            console.log(`  ✓ Identified ${speakers.size} speakers in transcript`);
            
            return {
                speakers: Array.from(speakers.values()),
                totalDuration: this.extractDurationFromVTT(vttContent),
                hasMultipleSpeakers: speakers.size > 1
            };
        } catch (error) {
            console.error('  Error analyzing transcript:', error.message);
            return null;
        }
    }
    // Enhanced transcript analysis with company name filtering
async analyzeTranscriptEnhanced(transcriptFileId) {
    try {
        console.log('  📝 Enhanced transcript analysis...');
        
        const response = await this.drive.files.get({
            fileId: transcriptFileId,
            alt: 'media'
        });
        
        const vttContent = response.data.toString();
        
        // Parse VTT format
        const speakers = new Map();
        const lines = vttContent.split('\n');
        
        // Enhanced patterns
        const nameExtractionPatterns = [
            /(?:I'm|I am|This is|My name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
            /(?:Coach|Professor|Dr\.?)\s+([A-Z][a-z]+)/i,
            /Hi\s+([A-Z][a-z]+),?\s+(?:I'm|this is)/i
        ];
        
        for (const line of lines) {
            if (line.includes(':') && !line.includes('-->')) {
                const colonIndex = line.indexOf(':');
                let speaker = line.substring(0, colonIndex).trim();
                const text = line.substring(colonIndex + 1).trim();
                
                // Convert "Ivy Mentors" to "Ivylevel"
                if (speaker.toLowerCase() === 'ivy mentors') {
                    speaker = 'Ivylevel';
                    console.log('   ✓ Converted "Ivy Mentors" to "Ivylevel"');
                }
                
                if (!speakers.has(speaker)) {
                    speakers.set(speaker, {
                        messageCount: 0,
                        possibleNames: new Set()
                    });
                }
                    
                const speakerData = speakers.get(speaker);
                speakerData.messageCount++;
                
                // Try to extract names
                for (const pattern of nameExtractionPatterns) {
                    const match = text.match(pattern);
                    if (match && !this.isCompanyName(match[1])) {
                        speakerData.possibleNames.add(match[1]);
                    }
                }
            }
        }
        
        console.log(`  ✓ Identified ${speakers.size} speakers in transcript`);
        
        // Detect Ivylevel presence
        const hasIvylevel = speakers.has('Ivylevel');
        
        return {
            speakers: Array.from(speakers.values()),
            totalDuration: this.extractDurationFromVTT(vttContent),
            hasMultipleSpeakers: speakers.size > 1,
            hasIvylevel: hasIvylevel
        };
    } catch (error) {
        console.error('  Error in enhanced transcript analysis:', error.message);
        return null;
    }
}
    extractDurationFromVTT(vttContent) {
        // Extract the last timestamp to get duration
        const timestampPattern = /(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->/g;
        let lastTimestamp = '00:00:00.000';
        let match;
        
        while ((match = timestampPattern.exec(vttContent)) !== null) {
            lastTimestamp = match[1];
        }
        
        return lastTimestamp;
    }

    // New method for chat analysis
    async analyzeChatFile(chatFileId) {
        try {
            console.log('  💬 Analyzing chat file for participant information...');
            
            const response = await this.drive.files.get({
                fileId: chatFileId,
                alt: 'media'
            });
            
            const chatContent = response.data.toString();
            
            // Parse chat format
            const chatPattern = /^(\d{2}:\d{2}:\d{2})\s+From\s+(.+?)\s+to\s+(.+?):\s*(.*)$/gm;
            const participants = new Map();
            const messages = [];
            
            let match;
            while ((match = chatPattern.exec(chatContent)) !== null) {
                const [, timestamp, sender, recipient, message] = match;
                
                if (!participants.has(sender)) {
                    participants.set(sender, {
                        name: sender,
                        messageCount: 0,
                        firstMessage: timestamp,
                        lastMessage: timestamp,
                        isLikelyCoach: false,
                        isLikelyStudent: false
                    });
                }
                
                const participant = participants.get(sender);
                participant.messageCount++;
                participant.lastMessage = timestamp;
                
                messages.push({ timestamp, sender, recipient, message });
                
                // Check for coach indicators in chat
                if (message.match(/(?:assignment|homework|practice|review|feedback)/i)) {
                    participant.isLikelyCoach = true;
                }
                
                // Check for student indicators
                if (message.match(/(?:question|help|confused|understand|struggling)/i)) {
                    participant.isLikelyStudent = true;
                }
            }
            
            console.log(`  ✓ Found ${participants.size} chat participants`);
            
            return {
                participants: Array.from(participants.values()),
                totalMessages: messages.length,
                messages: messages
            };
        } catch (error) {
            console.error('  Error analyzing chat file:', error.message);
            return null;
        }
    }

    // Enhanced metadata extraction from all sources
    async extractMetadataFromAllSources(recording, tempFiles, timelineData = null) {
        console.log('\n🔍 Starting comprehensive metadata extraction...');
        
        const metadata = {
            coach: null,
            student: null,
            weekNumber: null,
            participants: [],
            confidence: {
                coach: 0,
                student: 0,
                week: 0
            },
            sources: {
                coach: null,
                student: null,
                week: null
            }
        };
        
        // 1. Try existing topic-based extraction first
        metadata.coach = this.extractCoachFromRecordingInfo(
            recording.topic,
            recording.host_email,
            recording.participants
        );
        
        if (metadata.coach) {
            metadata.confidence.coach = 0.7;
            metadata.sources.coach = 'topic/host';
        }
        
        metadata.student = this.extractStudentFromRecordingInfo(
            recording.topic,
            metadata.coach
        );
        
        if (metadata.student) {
            metadata.confidence.student = 0.7;
            metadata.sources.student = 'topic';
        }
        
        metadata.weekNumber = this.extractWeekNumber(recording.topic);
        if (metadata.weekNumber) {
            metadata.confidence.week = 0.8;
            metadata.sources.week = 'topic';
        }
        
        // 2. Use timeline data if available
        if (timelineData && timelineData.participants) {
            metadata.participants = timelineData.participants;
            
            if (timelineData.coach && (!metadata.coach || metadata.confidence.coach < timelineData.confidence.coach)) {
                metadata.coach = timelineData.coach;
                metadata.confidence.coach = timelineData.confidence.coach;
                metadata.sources.coach = 'timeline';
            }
            
            if (timelineData.student && (!metadata.student || metadata.confidence.student < timelineData.confidence.student)) {
                metadata.student = timelineData.student;
                metadata.confidence.student = timelineData.confidence.student;
                metadata.sources.student = 'timeline';
            }
        }
        
        // 3. Analyze transcript if available and still missing info
        const transcriptFile = tempFiles.find(f => f.type === 'TRANSCRIPT' || f.type === 'VTT');
        if (transcriptFile && (!metadata.coach || !metadata.student || 
            metadata.confidence.coach < 0.8 || metadata.confidence.student < 0.8)) {
            
            const transcriptData = await this.analyzeTranscript(transcriptFile.fileId);
            if (transcriptData) {
                // Try to match speakers with identified roles
                for (const speaker of transcriptData.speakers) {
                    if (speaker.identifiedRole === 'coach' && speaker.possibleNames.size > 0) {
                        for (const name of speaker.possibleNames) {
                            const nameLower = name.toLowerCase();
                            if (this.knownCoachNames.has(nameLower)) {
                                if (!metadata.coach || metadata.confidence.coach < 0.85) {
                                    metadata.coach = this.capitalizeWord(name);
                                    metadata.confidence.coach = 0.85;
                                    metadata.sources.coach = 'transcript';
                                }
                                break;
                            }
                        }
                    } else if (speaker.identifiedRole === 'student' && speaker.possibleNames.size > 0) {
                        const studentName = Array.from(speaker.possibleNames)[0];
                        if (!metadata.student || metadata.confidence.student < 0.85) {
                            metadata.student = studentName;
                            metadata.confidence.student = 0.85;
                            metadata.sources.student = 'transcript';
                        }
                    }
                }
            }
        }
        
        // 4. Analyze chat file as supplementary source
        const chatFile = tempFiles.find(f => f.type === 'CHAT');
        if (chatFile && (!metadata.coach || !metadata.student || 
            metadata.confidence.coach < 0.7 || metadata.confidence.student < 0.7)) {
            
            const chatData = await this.analyzeChatFile(chatFile.fileId);
            if (chatData) {
                // Look for coach patterns in participant names
                for (const participant of chatData.participants) {
                    const nameLower = participant.name.toLowerCase();
                    
                    // Check against known coaches
                    for (const coachName of this.knownCoachNames) {
                        if (nameLower.includes(coachName)) {
                            if (!metadata.coach || metadata.confidence.coach < 0.6) {
                                metadata.coach = this.capitalizeWord(coachName);
                                metadata.confidence.coach = 0.6;
                                metadata.sources.coach = 'chat';
                            }
                            break;
                        }
                    }
                    
                    // Use message patterns to identify roles
                    if (participant.isLikelyCoach && !metadata.coach) {
                        // Extract first name from participant name
                        const firstName = participant.name.split(' ')[0];
                        if (this.knownCoachNames.has(firstName.toLowerCase())) {
                            metadata.coach = firstName;
                            metadata.confidence.coach = 0.5;
                            metadata.sources.coach = 'chat+behavior';
                        }
                    }
                }
            }
        }
        
        // 5. Enhanced week number extraction
        if (!metadata.weekNumber || metadata.confidence.week < 0.7) {
            // Try to extract from all available text sources
            const allText = [
                recording.topic,
                ...metadata.participants.map(p => p.username || ''),
                recording.host_id || ''
            ].join(' ');
            
            const enhancedWeekPatterns = [
                /w(?:ee)?k\s*[#-]?\s*(\d+)/i,
                /session\s*[#-]?\s*(\d+)/i,
                /meeting\s*[#-]?\s*(\d+)/i,
                /(\d+)(?:st|nd|rd|th)?\s*(?:week|session|meeting)/i,
                /wk(\d+)/i,
                /w(\d+)/i
            ];
            
            for (const pattern of enhancedWeekPatterns) {
                const match = allText.match(pattern);
                if (match) {
                    metadata.weekNumber = match[1];
                    metadata.confidence.week = 0.75;
                    metadata.sources.week = 'enhanced_patterns';
                    break;
                }
            }
        }
        
        // 6. Final fallback: calculate from date
        if (!metadata.weekNumber) {
            const studentEmail = this.identifyStudent(recording);
            if (studentEmail) {
                metadata.weekNumber = this.calculateWeekNumber(studentEmail, recording.start_time);
                metadata.confidence.week = 0.6;
                metadata.sources.week = 'calculated';
            }
        }
        
        // Log extraction results
        console.log('\n📊 Metadata extraction results:');
        console.log(`  Coach: ${metadata.coach || 'Unknown'} (${(metadata.confidence.coach * 100).toFixed(0)}% from ${metadata.sources.coach || 'none'})`);
        console.log(`  Student: ${metadata.student || 'Unknown'} (${(metadata.confidence.student * 100).toFixed(0)}% from ${metadata.sources.student || 'none'})`);
        console.log(`  Week: ${metadata.weekNumber || 'Unknown'} (${(metadata.confidence.week * 100).toFixed(0)}% from ${metadata.sources.week || 'none'})`);
        console.log(`  Participants found: ${metadata.participants.length}`);
        
        return metadata;
    }

    // New method to flag for manual review
    async flagForManualReview(recording, metadata, tempFolderPath) {
        console.log('\n⚠️ Flagging recording for manual review due to low confidence');
        
        try {
            // Check if Manual_Review sheet exists, create if not
            const sheets = await this.sheets.spreadsheets.get({
                spreadsheetId: this.mappingsSheetId,
                fields: 'sheets.properties.title'
            });
            
            const manualReviewExists = sheets.data.sheets.some(
                sheet => sheet.properties.title === 'Manual_Review'
            );
            
            if (!manualReviewExists) {
                await this.sheets.spreadsheets.batchUpdate({
                    spreadsheetId: this.mappingsSheetId,
                    resource: {
                        requests: [{
                            addSheet: {
                                properties: {
                                    title: 'Manual_Review',
                                    gridProperties: {
                                        rowCount: 1000,
                                        columnCount: 10
                                    }
                                }
                            }
                        }]
                    }
                });
                
                // Add headers
                const headers = [[
                    'Meeting ID',
                    'Topic',
                    'Coach (Extracted)',
                    'Student (Extracted)',
                    'Coach Confidence',
                    'Student Confidence',
                    'Week Confidence',
                    'Date Added',
                    'Status',
                    'Temp Folder Path'
                ]];
                
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId: this.mappingsSheetId,
                    range: 'Manual_Review!A1:J1',
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: headers }
                });
            }
            
            // Add the recording to review queue
            const values = [[
                recording.id || recording.uuid,
                recording.topic,
                metadata.coach || 'Unknown',
                metadata.student || 'Unknown',
                metadata.confidence.coach.toFixed(2),
                metadata.confidence.student.toFixed(2),
                metadata.confidence.week.toFixed(2),
                new Date().toISOString(),
                'Needs Review',
                tempFolderPath
            ]];
            
            await this.sheets.spreadsheets.values.append({
                spreadsheetId: this.mappingsSheetId,
                range: 'Manual_Review!A:J',
                valueInputOption: 'USER_ENTERED',
                resource: { values }
            });
            
            console.log('✓ Added to manual review queue');
        } catch (error) {
            console.error('Error flagging for manual review:', error.message);
        }
    }

    async processWebhookPayload(payload, downloadToken = null) {
        await this.initialize();
        
        const recording = payload.object || payload;
        console.log(`\n📹 Processing recording: ${recording.topic}`);
        
        // Step 1: Create temp folder for this recording with date organization
        const recordingDate = new Date(recording.start_time);
        const dateFolder = recordingDate.toISOString().split('T')[0]; // YYYY-MM-DD
        const tempDateFolderId = await this.getOrCreateFolder(
            this.folderCache.get('TEMP_ZOOM_RECORDINGS'),
            dateFolder
        );
        
        // Create unique temp folder name with timestamp
        const timestamp = recordingDate.toISOString().replace(/[:.]/g, '-');
        const tempFolderName = `${recording.topic}_${timestamp}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const tempRecordingFolderId = await this.getOrCreateFolder(tempDateFolderId, tempFolderName);
        const tempFolderPath = `TEMP_ZOOM_RECORDINGS/${dateFolder}/${tempFolderName}`;
        
        console.log(`✓ Created temp folder: ${tempFolderPath}`);
        
        // Step 2: Download and store all files in temp folder first
        const tempFiles = [];
        const recordingFiles = recording.recording_files || [];
        
        console.log(`Found ${recordingFiles.length} recording files to process`);
        
        for (const file of recordingFiles) {
            if (file.status !== 'completed') {
                console.log(`Skipping ${file.file_type} - status: ${file.status}`);
                continue;
            }
            
            console.log(`Processing file: ${file.file_type}, size: ${file.file_size}, download_url: ${file.download_url ? 'present' : 'missing'}`);
            
            try {
                const fileInfo = await this.downloadAndStoreFile(
                    file,
                    tempRecordingFolderId,
                    downloadToken,  // Use the download token from webhook
                    file.file_type,
                    recording.password || recording.recording_play_passcode  // Try both password fields
                );
                
                if (fileInfo) {
                    tempFiles.push({
                        type: file.file_type,
                        fileId: fileInfo.id,
                        fileName: fileInfo.name,
                        webViewLink: fileInfo.webViewLink
                    });
                }
            } catch (error) {
                console.error(`Error downloading ${file.file_type}:`, error.message);
                
                // If download token fails, try with OAuth token
                if (downloadToken && error.message && error.message.includes('401')) {
                    console.log(`Retrying ${file.file_type} with OAuth token...`);
                    try {
                        const oauthToken = await this.getZoomToken();
                        const fileInfo = await this.downloadAndStoreFile(
                            file,
                            tempRecordingFolderId,
                            oauthToken,  // Try with OAuth token
                            file.file_type,
                            recording.password || recording.recording_play_passcode
                        );
                        
                        if (fileInfo) {
                            tempFiles.push({
                                type: file.file_type,
                                fileId: fileInfo.id,
                                fileName: fileInfo.name,
                                webViewLink: fileInfo.webViewLink
                            });
                        }
                    } catch (retryError) {
                        console.error(`OAuth retry failed for ${file.file_type}:`, retryError.message);
                    }
                }
            }
        }
        
        console.log(`✓ Downloaded ${tempFiles.length} of ${recordingFiles.length} files to temp folder`);
        
        // If no files were downloaded, still continue with the process to log the attempt
        if (tempFiles.length === 0) {
            console.warn('⚠️ No files were successfully downloaded, but continuing to log the recording attempt');
        }
        
        // Step 3: Apply smart logic to identify coach and student
        let metadata = {
            coach: null,
            student: null,
            weekNumber: null,
            participants: [],
            confidence: { coach: 0, student: 0, week: 0 },
            sources: { coach: null, student: null, week: null }
        };
        
        let hasGamePlan = false;
        let isSiraj = false;
        
        // Check if this is a Siraj recording
        if (this.isSirajRecording(recording.topic)) {
            isSiraj = true;
            metadata.coach = "Siraj";
            metadata.confidence.coach = 1.0;
            metadata.sources.coach = 'siraj_pattern';
            console.log("✓ Detected as Siraj (MISC) recording");
        } else {
           // Try parsing the timeline file first if it was downloaded
        let timelineData = null;
        let timelineParticipants = null;
        if (tempFiles.length > 0) {
            const timelineFile = tempFiles.find(f => f.type === 'TIMELINE');
            if (timelineFile) {
                console.log('Attempting to extract participant info from timeline file...');
                try {
                    // Download the timeline content from Drive to parse it
                    const timelineContent = await this.drive.files.get({
                        fileId: timelineFile.fileId,
                        alt: 'media'
                    });
                    
                    if (timelineContent.data) {
                        const timelineJson = JSON.parse(timelineContent.data);
                        timelineData = this.parseTimelineForParticipants(timelineJson);
                        // Also run enhanced parsing
                        timelineParticipants = this.parseTimelineForParticipantsEnhanced(timelineJson);
                    }
                } catch (error) {
                    console.error('Error parsing timeline file:', error.message);
                }
            }
        }
            
            // Extract metadata from all sources
            metadata = await this.extractMetadataFromAllSources(recording, tempFiles, timelineData);
            
            hasGamePlan = this.hasGamePlanIndicator(recording.topic);

             // ============= ADD PATCH 7b HERE ============= //
    // Filter out company names
    if (metadata.coach && this.isCompanyName(metadata.coach)) {
        console.log(`  ⚠️  Filtered out company name as coach: ${metadata.coach}`);
        metadata.coach = null;
        metadata.confidence.coach = 0;
    }

    if (metadata.student && this.isCompanyName(metadata.student)) {
        console.log(`  ⚠️  Filtered out company name as student: ${metadata.student}`);
        metadata.student = null;
        metadata.confidence.student = 0;
    }

    // Use enhanced timeline data if available
    if (timelineParticipants) {
        if (timelineParticipants.isIvylevel) {
            metadata.coach = 'Ivylevel';
            metadata.confidence.coach = 0.9;
            metadata.sources.coach = 'timeline_ivylevel';
            console.log(`✓ Detected as Ivylevel recording`);
        } else {
            if (timelineParticipants.coach && (!metadata.coach || metadata.confidence.coach < timelineParticipants.confidence.coach)) {
                metadata.coach = timelineParticipants.coach;
                metadata.confidence.coach = timelineParticipants.confidence.coach;
                metadata.sources.coach = 'timeline_enhanced';
            }
            
            if (timelineParticipants.student && (!metadata.student || metadata.confidence.student < timelineParticipants.confidence.student)) {
                metadata.student = timelineParticipants.student;
                metadata.confidence.student = timelineParticipants.confidence.student;
                metadata.sources.student = 'timeline_enhanced';
            }
        }
    }
    // ============= END OF PATCH 7b ============= //
}
        
        // If we couldn't extract coach/student from any source, try mappings
        if (!metadata.student && !isSiraj) {
            const studentEmail = this.identifyStudent(recording);
            if (studentEmail) {
                const studentInfo = this.studentMappings.get(studentEmail);
                if (studentInfo) {
                    metadata.student = studentInfo.name;
                    metadata.confidence.student = 0.9;
                    metadata.sources.student = 'mappings';
                    
                    if (!metadata.coach) {
                        metadata.coach = studentInfo.coach;
                        metadata.confidence.coach = 0.9;
                        metadata.sources.coach = 'mappings';
                    }
                    if (!metadata.weekNumber) {
                        metadata.weekNumber = this.calculateWeekNumber(studentEmail, recording.start_time);
                        metadata.confidence.week = 0.7;
                        metadata.sources.week = 'calculated';
                    }
                }
            }
        }
        
        // Set defaults if still missing
        if (!metadata.coach && !isSiraj) metadata.coach = 'Unknown Coach';
        if (!metadata.student && !isSiraj) metadata.student = 'Unknown Student';
        
        const studentEmail = this.identifyStudent(recording) || 'unknown@email.com';
        const studentInfo = this.studentMappings.get(studentEmail) || {
            name: metadata.student,
            coach: metadata.coach,
            program: 'Unknown Program',
            startDate: new Date().toISOString().split('T')[0]
        };
        
        if (!metadata.weekNumber && !isSiraj) {
            metadata.weekNumber = this.calculateWeekNumber(studentEmail, recording.start_time);
            metadata.confidence.week = 0.6;
            metadata.sources.week = 'calculated_fallback';
        }
        
        console.log(`✓ Identified: Coach=${metadata.coach}, Student=${metadata.student}, Week=${metadata.weekNumber}, GamePlan=${hasGamePlan}`);
        console.log(`   Confidence levels - Coach: ${(metadata.confidence.coach * 100).toFixed(0)}%, Student: ${(metadata.confidence.student * 100).toFixed(0)}%, Week: ${(metadata.confidence.week * 100).toFixed(0)}%`);
        
        // Flag for manual review if confidence is low
        if (!isSiraj && (metadata.confidence.coach < 0.5 || metadata.confidence.student < 0.5)) {
            await this.flagForManualReview(recording, metadata, tempFolderPath);
        }
        
        // Step 4: Create final folder structure
        const folders = await this.createFolderStructure(
            studentEmail,
            metadata.coach,
            studentInfo.program,
            metadata.weekNumber || '1'
        );
        
        // Step 5: Copy files from temp to final locations with standardized names
        const processedFiles = {};
        
        for (const tempFile of tempFiles) {
            const standardizedName = this.generateStandardizedFileNameEnhanced(
                tempFile.type,
                metadata.coach,
                metadata.student,
                metadata.weekNumber,
                dateFolder,
                recording.id || recording.uuid,
                hasGamePlan,
                isSiraj,
                metadata.coach === 'Ivylevel' // isIvylevel parameter
            );
            
            // Copy to all three locations
            try {
                // Copy to By Student (primary)
                const primaryCopy = await this.copyFile(tempFile.fileId, folders.byStudent, standardizedName);
                processedFiles[tempFile.type.toLowerCase()] = primaryCopy.webViewLink;
                
                // Copy to other locations
                await Promise.all([
                    this.copyFile(tempFile.fileId, folders.byProgram, standardizedName),
                    this.copyFile(tempFile.fileId, folders.byCoach, standardizedName)
                ]);
                
                console.log(`✓ Copied ${standardizedName} to all locations`);
            } catch (error) {
                console.error(`Error copying ${tempFile.type}:`, error.message);
            }
        }
        
        // Update tracking spreadsheet with enhanced metadata
        await this.updateTrackingSpreadsheetEnhanced({
            meetingId: recording.id || recording.uuid,
            topic: recording.topic,
            student: metadata.student,
            studentEmail: studentEmail,
            coach: metadata.coach,
            program: studentInfo.program,
            week: metadata.weekNumber,
            date: recording.start_time,
            duration: recording.duration,
            files: processedFiles,
            host: recording.host_email || '',
            tempFolderPath: tempFolderPath,
            confidence: metadata.confidence,
            sources: metadata.sources,
            participantCount: metadata.participants.length
        });
        
        console.log(`\n✅ Successfully processed recording for ${metadata.student}`);
        
        return {
            success: true,
            student: metadata.student,
            coach: metadata.coach,
            week: metadata.weekNumber,
            filesProcessed: tempFiles.length,
            files: processedFiles,
            tempFolder: tempFolderPath,
            confidence: metadata.confidence,
            sources: metadata.sources
        };
    }

    async downloadAndStoreFile(file, folderId, authToken, fileType, recordingPassword = null) {
        console.log(`  📥 Downloading ${fileType}...`);

        // FOR TESTING ONLY - Skip actual downloads
        if (process.env.SKIP_DOWNLOADS === 'true') {
            console.log(`  ⏭️  Skipping download for testing`);
            return {
                id: `test-${fileType}-${Date.now()}`,
                name: `TEST_${fileType}.${fileType.toLowerCase()}`,
                webViewLink: `https://drive.google.com/test/${fileType}`
            };
        }
        
        // Check if download URL exists
        if (!file.download_url) {
            console.error(`  No download URL for ${fileType}`);
            return null;
        }
        
        // Prepare download URL and headers
        let downloadUrl = file.download_url;
        const headers = {};
        
        // Handle authentication
        if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
            console.log(`  Using ${authToken.length > 100 ? 'download' : 'OAuth'} token for authentication`);
        }
        
        // Add password if provided (for password-protected recordings)
        if (recordingPassword) {
            console.log(`  Adding recording password to URL`);
            try {
                const urlObj = new URL(downloadUrl);
                urlObj.searchParams.append('pwd', recordingPassword);
                downloadUrl = urlObj.toString();
            } catch (urlError) {
                console.error(`  Error parsing URL: ${urlError.message}`);
            }
        }
        
        // Download with retries
        let stream;
        let lastError;
        
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                console.log(`  Attempt ${attempt}/3 for ${fileType}...`);
                const response = await axios.get(downloadUrl, {
                    headers: headers,
                    responseType: 'stream',
                    timeout: 300000,
                    maxRedirects: 5,  // Allow redirects
                    validateStatus: function (status) {
                        return status >= 200 && status < 500; // Don't throw on 4xx to handle them manually
                    }
                });
                
                // Check if we got an error response
                if (response.status >= 400) {
                    let errorData = '';
                    try {
                        errorData = await this.streamToString(response.data);
                    } catch (e) {
                        errorData = `Unable to read error response: ${e.message}`;
                    }
                    console.error(`  HTTP ${response.status} error:`, errorData);
                    
                    // If it's a 401/403 and we have a token, the token might be invalid
                    if ((response.status === 401 || response.status === 403)) {
                        throw new Error(`Authentication failed: ${response.status} - ${errorData}`);
                    }
                    
                    throw new Error(`HTTP ${response.status}: ${errorData}`);
                }
                
                stream = response.data;
                break;
            } catch (error) {
                lastError = error;
                console.error(`  Error on attempt ${attempt}:`, error.message);
                
                if (attempt === 3) {
                    throw lastError;
                }
                
                // Wait before retry with exponential backoff
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
        }
        
        if (!stream) {
            throw lastError || new Error('Failed to download after 3 attempts');
        }
        
        // Determine file extension and MIME type
        let extension, mimeType;
        switch (fileType) {
            case 'MP4':
                extension = '.mp4';
                mimeType = 'video/mp4';
                break;
            case 'M4A':
                extension = '.m4a';
                mimeType = 'audio/mp4';
                break;
            case 'TRANSCRIPT':
            case 'VTT':
                extension = '.vtt';
                mimeType = 'text/vtt';
                break;
            case 'CHAT':
                extension = '.txt';
                mimeType = 'text/plain';
                break;
            case 'TIMELINE':
                extension = '.json';
                mimeType = 'application/json';
                break;
            default:
                console.log(`Skipping unknown file type: ${fileType}`);
                return null;
        }
        
        const tempFileName = `${fileType}${extension}`;
        
        // Upload to temp folder
        console.log(`  📤 Uploading ${tempFileName} to temp folder...`);
        const upload = await this.uploadToDrive(stream, tempFileName, folderId, mimeType);
        
        console.log(`  ✓ ${tempFileName} uploaded to temp folder`);
        return upload;
    }
    
    // Helper function to convert stream to string for error messages
    async streamToString(stream) {
        const chunks = [];
        return new Promise((resolve, reject) => {
            stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            stream.on('error', (err) => reject(err));
            stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
    }

    generateStandardizedFileName(fileType, coach, student, weekNumber, date, meetingId, hasGamePlan, isSiraj) {
        // Clean names
        const cleanCoach = coach.replace(/[^a-zA-Z0-9]/g, '_');
        const cleanStudent = student.replace(/[^a-zA-Z0-9]/g, '_');
        
        // Build base name
        let baseName;
        if (isSiraj) {
            baseName = `MISC_Siraj_${cleanStudent}`;
        } else {
            baseName = `${cleanCoach}_${cleanStudent}`;
        }
        
        // Add GamePlan if detected
        if (hasGamePlan && !isSiraj) {
            baseName = `${baseName}_GamePlan`;
        }
        
        // Add week number if available
        if (weekNumber && !isSiraj) {
            baseName = `${baseName}_Wk${weekNumber}`;
        }
        
        // Add date
        baseName = `${baseName}_${date}`;
        
        // Add meeting ID if available
        if (meetingId) {
            // Clean meeting ID (remove special characters)
            const cleanMeetingId = String(meetingId).replace(/[^a-zA-Z0-9]/g, '');
            baseName = `${baseName}_${cleanMeetingId}`;
        }
        
        // Add file type suffix and extension
        let suffix, extension;
        switch (fileType) {
            case 'MP4':
                suffix = '_Video';
                extension = '.mp4';
                break;
            case 'M4A':
                suffix = '_Audio';
                extension = '.m4a';
                break;
            case 'TRANSCRIPT':
            case 'VTT':
                suffix = '_Transcript';
                extension = '.vtt';
                break;
            case 'CHAT':
                suffix = '_Chat';
                extension = '.txt';
                break;
            case 'TIMELINE':
                suffix = '_Timeline';
                extension = '.json';
                break;
            default:
                suffix = '';
                extension = '';
        }
        
        return `${baseName}${suffix}${extension}`;
    }
    // Enhanced file name generation with V100 logic
    generateStandardizedFileNameEnhanced(fileType, coach, student, weekNumber, date, meetingId, hasGamePlan, isSiraj, isIvylevel) {
        // Clean names - handle special characters including spaces
        const cleanCoach = coach.replace(/[^a-zA-Z0-9\s-]/g, '_').replace(/\s+/g, ' ').trim();
        const cleanStudent = student.replace(/[^a-zA-Z0-9\s-]/g, '_').replace(/\s+/g, ' ').trim();
        
        // Build base name
        let baseName;
        if (isSiraj) {
            // Extract context from folder name for MISC recordings
            const context = this.extractContextFromSirajFolder(cleanStudent);
            if (context) {
                baseName = `MISC_Siraj_${context}_${cleanStudent}`;
            } else {
                baseName = `MISC_Siraj_${cleanStudent}`;
            }
        } else if (isIvylevel) {
            baseName = `Ivylevel_${cleanStudent}`;
        } else {
            baseName = `${cleanCoach}_${cleanStudent}`;
        }
        
        // Replace spaces with underscores in base name
        baseName = baseName.replace(/\s+/g, '_');
        
        // Add GamePlan if detected
        if (hasGamePlan && !isSiraj) {
            baseName = `${baseName}_GamePlan`;
        }
        
        // Add week number if available and not Siraj
        if (weekNumber && !isSiraj) {
            baseName = `${baseName}_Wk${weekNumber}`;
        }
        
        // Add date
        baseName = `${baseName}_${date}`;
        
        // Add file type suffix and extension
        let suffix, extension;
        switch (fileType) {
            case 'MP4':
                suffix = '_Video';
                extension = '.mp4';
                break;
            case 'M4A':
                suffix = '_Audio';
                extension = '.m4a';
                break;
            case 'TRANSCRIPT':
            case 'VTT':
                suffix = '_Transcript';
                extension = '.vtt';
                break;
            case 'CHAT':
                suffix = '_Chat';
                extension = '.txt';
                break;
            case 'TIMELINE':
                suffix = '_Timeline';
                extension = '.json';
                break;
            default:
                suffix = '';
                extension = '';
        }
        
        return `${baseName}${suffix}${extension}`;
    }

    identifyStudent(recording) {
        const topic = (recording.topic || '').toLowerCase();
        
        // Check topic against all known students
        for (const [email, info] of this.studentMappings) {
            const nameParts = info.name.toLowerCase().split(' ');
            const emailPrefix = email.split('@')[0].toLowerCase();
            
            // Check if topic contains student name or email prefix
            if (nameParts.some(part => part.length > 2 && topic.includes(part)) || 
                topic.includes(emailPrefix)) {
                return email;
            }
        }

        // Check host email if it's a student
        if (recording.host_email) {
            const hostEmail = recording.host_email.toLowerCase();
            if (this.studentMappings.has(hostEmail)) {
                return hostEmail;
            }
        }

        return null;
    }

    calculateWeekNumber(studentEmail, meetingDate) {
        const studentInfo = this.studentMappings.get(studentEmail);
        if (!studentInfo || !studentInfo.startDate) return 1;

        const start = new Date(studentInfo.startDate);
        const meeting = new Date(meetingDate);
        const diffDays = Math.ceil((meeting - start) / (1000 * 60 * 60 * 24));
        
        return Math.max(1, Math.min(Math.ceil(diffDays / 7), 52));
    }

    async getOrCreateFolder(parentId, folderName) {
        const cacheKey = `${parentId}/${folderName}`;
        
        if (this.folderCache.has(cacheKey)) {
            return this.folderCache.get(cacheKey);
        }

        const query = `name='${folderName.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
        
        try {
            const response = await this.drive.files.list({
                q: query,
                fields: 'files(id)',
                pageSize: 1
            });

            if (response.data.files && response.data.files.length > 0) {
                const folderId = response.data.files[0].id;
                this.folderCache.set(cacheKey, folderId);
                return folderId;
            }
        } catch (error) {
            console.error(`Error checking folder: ${error.message}`);
        }

        // Create folder
        const folder = await this.drive.files.create({
            resource: {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId]
            },
            fields: 'id'
        });

        this.folderCache.set(cacheKey, folder.data.id);
        return folder.data.id;
    }

    async createFolderStructure(studentEmail, coachName, program, weekNumber) {
        const folders = {};

        // By Program structure
        const programFolderId = await this.getOrCreateFolder(
            this.folderCache.get('By Program'),
            program
        );
        const programStudentFolderId = await this.getOrCreateFolder(
            programFolderId,
            studentEmail
        );
        folders.byProgram = await this.getOrCreateFolder(
            programStudentFolderId,
            `Week ${weekNumber}`
        );

        // By Coach structure
        const coachFolderId = await this.getOrCreateFolder(
            this.folderCache.get('By Coach'),
            coachName
        );
        const coachStudentFolderId = await this.getOrCreateFolder(
            coachFolderId,
            studentEmail
        );
        folders.byCoach = await this.getOrCreateFolder(
            coachStudentFolderId,
            `Week ${weekNumber}`
        );

        // By Student structure
        const studentFolderId = await this.getOrCreateFolder(
            this.folderCache.get('By Student'),
            studentEmail
        );
        folders.byStudent = await this.getOrCreateFolder(
            studentFolderId,
            `Week ${weekNumber}`
        );

        return folders;
    }

    async uploadToDrive(stream, fileName, folderId, mimeType) {
        const response = await this.drive.files.create({
            resource: {
                name: fileName,
                parents: [folderId]
            },
            media: {
                mimeType: mimeType,
                body: stream
            },
            fields: 'id, webViewLink, name'
        });

        return response.data;
    }

    async copyFile(fileId, targetFolderId, fileName) {
        try {
            const response = await this.drive.files.copy({
                fileId: fileId,
                resource: {
                    name: fileName,
                    parents: [targetFolderId]
                },
                fields: 'id, webViewLink'
            });
            return response.data;
        } catch (error) {
            console.error(`Error copying file: ${error.message}`);
            throw error;
        }
    }

    // Enhanced tracking spreadsheet update
    async updateTrackingSpreadsheetEnhanced(sessionData) {
        try {
            const values = [[
                sessionData.meetingId,
                sessionData.topic,
                sessionData.coach,
                sessionData.student,
                sessionData.program,
                sessionData.week,
                sessionData.date,
                sessionData.duration,
                sessionData.files.mp4 || '',
                sessionData.files.m4a || '',
                sessionData.files.transcript || sessionData.files.vtt || '',
                sessionData.files.chat || '',
                sessionData.host || '',
                new Date().toISOString(),
                sessionData.tempFolderPath || '',
                // New columns for enhanced tracking
                sessionData.confidence.coach.toFixed(2),
                sessionData.confidence.student.toFixed(2),
                sessionData.confidence.week.toFixed(2),
                sessionData.sources.coach || '',
                sessionData.sources.student || '',
                sessionData.sources.week || '',
                sessionData.participantCount || 0
            ]];

            await this.sheets.spreadsheets.values.append({
                spreadsheetId: this.mappingsSheetId,
                range: 'Sessions!A:V',
                valueInputOption: 'USER_ENTERED',
                resource: { values }
            });
            
            console.log('✓ Enhanced tracking spreadsheet updated');
        } catch (error) {
            console.error('Error updating spreadsheet:', error.message);
        }
    }

    // Fallback to original method for backward compatibility
    async updateTrackingSpreadsheet(sessionData) {
        // If called with old format, convert to enhanced format
        if (!sessionData.confidence) {
            sessionData.confidence = { coach: 1, student: 1, week: 1 };
            sessionData.sources = { coach: 'legacy', student: 'legacy', week: 'legacy' };
            sessionData.participantCount = 0;
        }
        return this.updateTrackingSpreadsheetEnhanced(sessionData);
    }
    // Helper method to check if a name is a company/organization name
    isCompanyName(name) {
        if (!name) return false;
        
        const companyIndicators = [
            'ivy mentor', 'ivymentor', 'ivy mentors', 'ivymentors',
            'company', 'corporation', 'corp', 'inc', 'llc', 'ltd',
            'organization', 'org', 'institute', 'academy',
            'services', 'consulting', 'partners', 'group'
        ];
        
        const nameLower = name.toLowerCase();
        
        // Check if the name contains any company indicators
        for (const indicator of companyIndicators) {
            if (nameLower.includes(indicator)) {
                return true;
            }
        }
        
        // Additional check: if it's exactly "Ivy Mentor" or similar
        if (nameLower === 'ivy mentor' || nameLower === 'ivy mentors') {
            return true;
        }
        
        return false;
    }

        // Extract context from Siraj folder names
    extractContextFromSirajFolder(folderName) {
        // Remove common patterns and clean up
        let cleaned = folderName
            .replace(/siraj/gi, '')
            .replace(/\d{10,}/, '') // Remove long numbers (meeting IDs)
            .replace(/_+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        
        // Look for context keywords
        const contextPatterns = [
            /checkpoint/i,
            /review/i,
            /planning/i,
            /strategy/i,
            /meeting/i,
            /discussion/i,
            /presentation/i
        ];
        
        for (const pattern of contextPatterns) {
            const match = cleaned.match(pattern);
            if (match) {
                // Also try to extract any associated name
                const names = cleaned.match(/(?:&|and|with)\s+([A-Za-z]+)/i);
                if (names && names[1]) {
                    return `${match[0]}_${names[1]}`;
                }
                return match[0];
            }
        }
        
        // If no specific context found but there's a name
        const nameMatch = cleaned.match(/([A-Za-z]+)/);
        if (nameMatch && nameMatch[1].length > 2) {
            return nameMatch[1];
        }
        
        return null;
    }

}

export default RecordingProcessor;

// If run directly, process from command line
if (import.meta.url === `file://${process.argv[1]}`) {
    const processor = new RecordingProcessor();
    
    // Example: node recording-processor.js process-webhook '{"object": {...}}'
    if (process.argv[2] === 'process-webhook' && process.argv[3]) {
        const payload = JSON.parse(process.argv[3]);
        // Extract download token if provided as 4th argument
        const downloadToken = process.argv[4] || null;
        
        processor.processWebhookPayload(payload, downloadToken)
            .then(result => {
                console.log('Result:', result);
                process.exit(0);
            })
            .catch(error => {
                console.error('Error:', error);
                process.exit(1);
            });
    } else {
        console.log('Usage: node recording-processor.js process-webhook \'{"object": {...}}\' [download_token]');
    }
}