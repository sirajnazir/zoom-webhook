// local-recording-analyzer.js
// Analyzes local Zoom recordings to test metadata extraction logic
// No downloads, no uploads - just analysis and logging

import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Initialize dotenv
dotenv.config();

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class LocalRecordingAnalyzer {
    constructor() {
        this.knownCoachNames = new Set([
            'noor', 'jenny', 'aditi', 'marissa', 'rishi', 'erin',
            'janice', 'summer', 'jamie', 'alice', 'alan', 'andrew', 'juli'
        ]);
        
        // Student mappings (add your real mappings here)
        this.studentMappings = new Map([
            ['student1@example.com', { name: 'John Doe', coach: 'Jenny', program: 'Premium' }],
            ['student2@example.com', { name: 'Jane Smith', coach: 'Noor', program: 'Standard' }]
        ]);
        
        this.results = [];
    }

    // Main processing function
    async analyzeLocalRecordings(rootPath) {
        console.log(`\n🔍 Analyzing recordings in: ${rootPath}\n`);
        
        try {
            const entries = await fs.readdir(rootPath, { withFileTypes: true });
            
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const folderPath = path.join(rootPath, entry.name);
                    await this.processRecordingFolder(folderPath, entry.name);
                }
            }
            
            // Print summary report
            this.printSummaryReport();
            
            // Save detailed results to file
            await this.saveResultsToFile();
            
        } catch (error) {
            console.error('Error reading directory:', error.message);
        }
    }

    // Process a single recording folder
    async processRecordingFolder(folderPath, folderName) {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`📁 Processing: ${folderName}`);
        console.log(`${'='.repeat(80)}`);
        
        const result = {
            folderName: folderName,
            folderPath: folderPath,
            files: [],
            extracted: {
                coach: null,
                student: null,
                week: null,
                hasGamePlan: false,
                isSiraj: false,
                isIvylevel: false
            },
            confidence: {
                coach: 0,
                student: 0,
                week: 0
            },
            sources: {
                coach: null,
                student: null,
                week: null
            },
            suggestedNames: []
        };
         // Check for Siraj recordings (MISC category)
         if (this.isSirajRecording(folderName)) {
            result.extracted.isSiraj = true;
            result.extracted.coach = "Siraj";
            result.confidence.coach = 1.0;
            result.sources.coach = 'siraj_pattern';
            console.log(`✓ Detected as Siraj (MISC) recording`);
        }
       
        
        try {
            // List all files in the folder
            const files = await fs.readdir(folderPath);
            result.files = files;
            
            console.log(`📄 Files found: ${files.length}`);
            files.forEach(file => console.log(`   - ${file}`));
            
            // ADD PATCH 2 HERE - Process metadata FIRST
            // Find and analyze metadata FIRST
            const metadataFile = files.find(f => f.includes('metadata.json'));
            if (metadataFile) {
                const metadataPath = path.join(folderPath, metadataFile);
                await this.analyzeMetadataFile(metadataPath, result);
            }
            
            // Extract from folder name first (only if metadata didn't provide info)
            if (!result.extracted.isSiraj) {
                this.extractFromFolderName(folderName, result);
            }
            
            // Find and analyze specific files
            for (const file of files) {
                const filePath = path.join(folderPath, file);
                
                if (file.includes('timeline') && file.endsWith('.json')) {
                    await this.analyzeTimelineFile(filePath, result);
                } else if (file.endsWith('.vtt')) {
                    await this.analyzeTranscriptFile(filePath, result);
                } else if (file.includes('chat') && file.endsWith('.txt')) {
                    await this.analyzeChatFile(filePath, result);
                }
                // Note: metadata.json is already processed above, so no need to process it again
            }
            
            // Check for Ivylevel scenario (only contact@ivymentors.co present)
            if (result.extracted.coach === 'contact' || 
                (result.sources.coach === 'timeline' && result.extracted.coach === 'contact@ivymentors.co')) {
                result.extracted.coach = 'Ivylevel';
                result.extracted.isIvylevel = true;
                result.sources.coach = 'ivylevel_pattern';
                console.log(`✓ Detected as Ivylevel recording (only contact@ivymentors.co present)`);
            }
            
            // Generate suggested standardized names
            this.generateStandardizedNames(result, files);
            
            // Print results for this folder
            this.printFolderResults(result);
            
            // Store for summary
            this.results.push(result);
            
        } catch (error) {
            console.error(`Error processing folder: ${error.message}`);
            result.error = error.message;
            this.results.push(result);
        }
    }

    // Improved extractFromFolderName method
    extractFromFolderName(folderName, result) {
        console.log(`\n🔎 Extracting from folder name: "${folderName}"`);
        
        const folderLower = folderName.toLowerCase();
        const parts = folderName.split('_');
        
        // Special handling for Siraj recordings to extract student name
        if (result.extracted.isSiraj) {
            const sirajStudentPattern = /siraj\s*(?:&|and)\s+([A-Za-z]+)/i;
            const match = folderName.match(sirajStudentPattern);
            if (match) {
                result.extracted.student = this.capitalizeWord(match[1]);
                result.confidence.student = 0.8;
                result.sources.student = 'folder_name_siraj_pattern';
                console.log(`   ✓ Found student in Siraj pattern: ${result.extracted.student}`);
            }
            return; // Exit early for Siraj recordings
        }

        // IMPROVED LOGIC: For pattern like Erin_Ye_Damaris_Mani-munoz_83494507644
        // We need to identify which parts are coach and which are student
        if (parts.length >= 4) {
            // Check if first part is a known coach name
            if (this.knownCoachNames.has(parts[0].toLowerCase())) {
                result.extracted.coach = this.capitalizeWord(parts[0]);
                result.confidence.coach = 0.85; // Higher confidence for direct pattern match
                result.sources.coach = 'folder_name_pattern';
                console.log(`   ✓ Found coach at position 0: ${result.extracted.coach}`);
                
                // Now determine student name from remaining parts
                // Remove coach part and any numeric parts (like meeting IDs)
                const remainingParts = parts.slice(1).filter(part => !part.match(/^\d+$/));
                
                if (remainingParts.length >= 2) {
                    // Check for hyphenated last names
                    const hyphenatedIndex = remainingParts.findIndex(part => part.includes('-'));
                    
                    if (hyphenatedIndex > 0) {
                        // Found hyphenated last name
                        const firstName = remainingParts[hyphenatedIndex - 1];
                        const lastName = remainingParts[hyphenatedIndex];
                        
                        // Skip the part immediately after coach if it's a single name that might be coach's last name
                        if (hyphenatedIndex === 2 && remainingParts.length === 3) {
                            // Pattern: Coach_CoachLastName_StudentFirst_StudentLast-hyphenated
                            result.extracted.student = `${this.capitalizeWord(firstName)} ${this.capitalizeWord(lastName)}`;
                        } else if (hyphenatedIndex === 1) {
                            // Pattern: Coach_StudentFirst_StudentLast-hyphenated
                            result.extracted.student = `${this.capitalizeWord(firstName)} ${this.capitalizeWord(lastName)}`;
                        }
                        
                        if (result.extracted.student) {
                            result.confidence.student = 0.85;
                            result.sources.student = 'folder_name_pattern_hyphenated';
                            console.log(`   ✓ Found student with hyphenated name: ${result.extracted.student}`);
                        }
                    } else {
                        // No hyphenated names, try to identify student
                        // Common pattern: Coach_StudentFirst_StudentLast or Coach_CoachLast_StudentFirst_StudentLast
                        
                        // If we have exactly 2 remaining parts, they're likely first and last name
                        if (remainingParts.length === 2) {
                            result.extracted.student = `${this.capitalizeWord(remainingParts[0])} ${this.capitalizeWord(remainingParts[1])}`;
                            result.confidence.student = 0.8;
                            result.sources.student = 'folder_name_pattern';
                            console.log(`   ✓ Found student: ${result.extracted.student}`);
                        } else if (remainingParts.length >= 3) {
                            // Might be Coach_CoachLast_StudentFirst_StudentLast
                            // Take the last two non-numeric parts
                            const lastTwo = remainingParts.slice(-2);
                            result.extracted.student = `${this.capitalizeWord(lastTwo[0])} ${this.capitalizeWord(lastTwo[1])}`;
                            result.confidence.student = 0.75;
                            result.sources.student = 'folder_name_pattern';
                            console.log(`   ✓ Found student (from last two parts): ${result.extracted.student}`);
                        }
                    }
                }
            }
        }
        
        // If we still don't have coach/student, continue with existing patterns...
        if (!result.extracted.coach) {
            // Look for known coach names in ANY position
            let coachFound = false;
            let coachIndex = -1;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i].toLowerCase();
                if (this.knownCoachNames.has(part)) {
                    result.extracted.coach = this.capitalizeWord(parts[i]);
                    result.confidence.coach = 0.8;
                    result.sources.coach = 'folder_name_pattern';
                    coachIndex = i;
                    coachFound = true;
                    console.log(`   ✓ Found coach from pattern: ${result.extracted.coach} at position ${i}`);
                    break;
                }
            }

            // If coach found at position > 0, look for student before coach
            if (coachFound && coachIndex > 0 && !result.extracted.student) {
                if (coachIndex >= 2 && !parts[0].match(/^\d+$/) && !parts[1].match(/^\d+$/)) {
                    result.extracted.student = `${this.capitalizeWord(parts[0])} ${this.capitalizeWord(parts[1])}`;
                    result.confidence.student = 0.8;
                    result.sources.student = 'folder_name_pattern';
                    console.log(`   ✓ Found student before coach: ${result.extracted.student}`);
                }
            }
        }
        
        // Rest of the existing extraction logic for week, game plan, etc...
        // Week extraction
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
            const match = folderName.match(pattern);
            if (match) {
                result.extracted.week = match[1];
                result.confidence.week = 0.8;
                result.sources.week = 'folder_name';
                console.log(`   ✓ Found week: ${result.extracted.week}`);
                break;
            }
        }
        
        // Game plan detection
        const gamePatterns = [
            /\bgame[_\s]*plan\b/i,
            /\bgameplan\b/i,
            /\bstrategy[_\s]*session\b/i,
            /\bplanning[_\s]*meeting\b/i
        ];
        
        result.extracted.hasGamePlan = gamePatterns.some(pattern => pattern.test(folderName));
        if (result.extracted.hasGamePlan) {
            console.log(`   ✓ Detected game plan indicator`);
        }
    }

    // Analyze timeline.json file
    async analyzeTimelineFile(filePath, result) {
        console.log(`\n📊 Analyzing timeline file...`);
        
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const timelineData = JSON.parse(content);
            
            const participants = new Map();
            const coaches = [];
            const students = [];
            let hasOnlyContactEmail = true;
            let hasOtherCoachEmail = false;
            
            if (timelineData.timeline && Array.isArray(timelineData.timeline)) {
                for (const event of timelineData.timeline) {
                    if (event.users && Array.isArray(event.users)) {
                        for (const user of event.users) {
                            if (user && user.username) {
                                const username = user.username;
                                const email = user.email_address || '';
                                
                                // Skip numeric usernames or 'Ivylevel'
                                if (username.match(/^\d+$/) || username.toLowerCase() === 'ivylevel') {
                                    continue;
                                }
                                
                                // Check if this is a coach email other than contact@
                                if (email && (email.includes('@ivymentors.co') || email.includes('@stanford.edu'))) {
                                    if (email !== 'contact@ivymentors.co') {
                                        hasOtherCoachEmail = true;
                                    }
                                } else if (email) {
                                    hasOnlyContactEmail = false;
                                }
                                
                                const isCoach = this.isLikelyCoach(username, email);
                                
                                participants.set(username, {
                                    username: username,
                                    email: email,
                                    isCoach: isCoach
                                });
                                
                                if (isCoach) {
                                    coaches.push(username);
                                } else {
                                    // If no email, or email is NOT @ivymentors.co/@stanford.edu, it's a student
                                    students.push(username);
                                }
                            }
                        }
                    }
                }
            }
            
            console.log(`   Found ${participants.size} participants`);
            console.log(`   Coaches: ${coaches.length}, Students: ${students.length}`);
            
            // Display all participants with their classification
            for (const [username, info] of participants) {
                console.log(`   - ${username} (${info.email || 'no email'}) ${info.isCoach ? '[COACH]' : '[STUDENT]'}`);
            }
            
            // Check if only contact@ivymentors.co is present
            if (hasOnlyContactEmail && !hasOtherCoachEmail && coaches.length === 1 && 
                (coaches[0] === 'contact@ivymentors.co' || coaches[0] === 'contact')) {
                // This will be handled in the main processing function
                console.log(`   ⚠️  Only contact@ivymentors.co present - will be marked as Ivylevel`);
            }
            
            // Assign coach if found
            if (coaches.length > 0 && (!result.extracted.coach || result.confidence.coach < 0.9)) {
                result.extracted.coach = coaches[0];
                result.confidence.coach = 0.9;
                result.sources.coach = 'timeline';
                console.log(`   ✓ Assigned coach: ${result.extracted.coach}`);
            }
            
            // Assign student if found
            if (students.length > 0 && (!result.extracted.student || result.confidence.student < 0.9)) {
                result.extracted.student = students[0];
                result.confidence.student = 0.9;
                result.sources.student = 'timeline';
                console.log(`   ✓ Assigned student: ${result.extracted.student}`);
            }
            
        } catch (error) {
            console.log(`   ⚠️  Error reading timeline: ${error.message}`);
        }
    }

    // Analyze VTT transcript file
    async analyzeTranscriptFile(filePath, result) {
        console.log(`\n📝 Analyzing transcript file...`);
    
    try {
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split('\n');
        
        const speakers = new Map();
        const namePatterns = [
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
                    for (const pattern of namePatterns) {
                        const match = text.match(pattern);
                        if (match) {
                            speakerData.possibleNames.add(match[1]);
                        }
                    }
                }
            }
            
            console.log(`   Found ${speakers.size} speakers`);
            
            // Check for coach names in extracted names
            for (const [speaker, data] of speakers) {
                for (const name of data.possibleNames) {
                    const nameLower = name.toLowerCase();
                    if (this.knownCoachNames.has(nameLower) && (!result.extracted.coach || result.confidence.coach < 0.85)) {
                        result.extracted.coach = this.capitalizeWord(name);
                        result.confidence.coach = 0.85;
                        result.sources.coach = 'transcript';
                        console.log(`   ✓ Found coach in transcript: ${result.extracted.coach}`);
                    }
                }
            }

            // ADD THE IVYLEVEL CHECK HERE:
            // Check if Ivylevel is present in the transcript
            if (speakers.has('Ivylevel') && !result.extracted.isIvylevel) {
                console.log('   ✓ Detected Ivylevel presence in transcript');
                // This will be handled in the main processing function
            }
            
        } catch (error) {
            console.log(`   ⚠️  Error reading transcript: ${error.message}`);
        }
    }

    // Analyze chat file
    async analyzeChatFile(filePath, result) {
        console.log(`\n💬 Analyzing chat file...`);
        
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const chatPattern = /^(\d{2}:\d{2}:\d{2})\s+From\s+(.+?)\s+to\s+(.+?):\s*(.*)$/gm;
            const participants = new Map();
            
            let match;
            while ((match = chatPattern.exec(content)) !== null) {
                const [, timestamp, sender, recipient, message] = match;
                
                if (!participants.has(sender)) {
                    participants.set(sender, {
                        name: sender,
                        messageCount: 0
                    });
                }
                
                participants.get(sender).messageCount++;
            }
            
            console.log(`   Found ${participants.size} chat participants`);
            
            for (const [name, info] of participants) {
                const nameLower = name.toLowerCase();
                console.log(`   - ${name} (${info.messageCount} messages)`);
                
                // Check for coach names
                for (const coachName of this.knownCoachNames) {
                    if (nameLower.includes(coachName) && (!result.extracted.coach || result.confidence.coach < 0.6)) {
                        result.extracted.coach = this.capitalizeWord(coachName);
                        result.confidence.coach = 0.6;
                        result.sources.coach = 'chat';
                        console.log(`   ✓ Found coach in chat: ${result.extracted.coach}`);
                        break;
                    }
                }
            }
            
        } catch (error) {
            console.log(`   ⚠️  Error reading chat: ${error.message}`);
        }
    }
   // Fixed analyzeMetadataFile method
    async analyzeMetadataFile(filePath, result) {
        console.log(`\n📋 Analyzing metadata file...`);
        
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const metadata = JSON.parse(content);
            
            // Extract from originalFolderName if available
            if (metadata.originalFolderName) {
                console.log(`   Original folder name: ${metadata.originalFolderName}`);
                
                // Create a temporary result object to extract from original name
                const tempResult = {
                    extracted: {
                        coach: null,
                        student: null,
                        week: null,
                        isSiraj: false
                    },
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
                
                // Run extraction on original folder name
                this.extractFromFolderName(metadata.originalFolderName, tempResult);
                
                // Use extracted values if better than current
                if (tempResult.extracted.coach && (!result.extracted.coach || tempResult.confidence.coach > result.confidence.coach)) {
                    // Skip if it's a company name
                    if (!this.isCompanyName(tempResult.extracted.coach)) {
                        result.extracted.coach = tempResult.extracted.coach;
                        result.confidence.coach = Math.max(tempResult.confidence.coach, 0.9);
                        result.sources.coach = 'metadata_original_name';
                        console.log(`   ✓ Found coach from metadata: ${result.extracted.coach}`);
                    }
                }
                
                if (tempResult.extracted.student && (!result.extracted.student || tempResult.confidence.student > result.confidence.student)) {
                    // Skip if it's a company name
                    if (!this.isCompanyName(tempResult.extracted.student)) {
                        result.extracted.student = tempResult.extracted.student;
                        result.confidence.student = Math.max(tempResult.confidence.student, 0.9);
                        result.sources.student = 'metadata_original_name';
                        console.log(`   ✓ Found student from metadata: ${result.extracted.student}`);
                    } else {
                        console.log(`   ⚠️  Skipped company name as student: ${tempResult.extracted.student}`);
                    }
                }
                
                if (tempResult.extracted.week && !result.extracted.week) {
                    result.extracted.week = tempResult.extracted.week;
                    result.confidence.week = tempResult.confidence.week;
                    result.sources.week = 'metadata_original_name';
                    console.log(`   ✓ Found week from metadata: ${result.extracted.week}`);
                }
            }
            
            // Extract coach info from email
            if (metadata.coach && metadata.coach.email && metadata.coach.email !== 'null' && !result.extracted.coach) {
                const coachName = this.extractNameFromEmail(metadata.coach.email);
                if (coachName && !this.isCompanyName(coachName)) {
                    result.extracted.coach = coachName;
                    result.confidence.coach = 0.8;
                    result.sources.coach = 'metadata_coach_email';
                    console.log(`   ✓ Found coach from metadata email: ${result.extracted.coach}`);
                }
            }
            
            // Extract student info from email  
            if (metadata.student && metadata.student.email && metadata.student.email !== 'unknown@student.com' && !result.extracted.student) {
                const studentName = this.extractNameFromEmail(metadata.student.email);
                if (studentName && !this.isCompanyName(studentName)) {
                    result.extracted.student = studentName;
                    result.confidence.student = 0.8;
                    result.sources.student = 'metadata_student_email';
                    console.log(`   ✓ Found student from metadata email: ${result.extracted.student}`);
                }
            }
            
            // Extract session type
            if (metadata.sessionType) {
                console.log(`   Session type: ${metadata.sessionType}`);
                result.sessionType = metadata.sessionType;
            }
            
        } catch (error) {
            console.log(`   ⚠️  Error reading metadata: ${error.message}`);
        }
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

// Helper method to extract name from email
extractNameFromEmail(email) {
    if (!email || email === 'unknown@student.com') return null;
    
    const localPart = email.split('@')[0];
    // Handle various email formats
    if (localPart.includes('.')) {
        const parts = localPart.split('.');
        return parts.map(p => this.capitalizeWord(p)).join(' ');
    } else {
        return this.capitalizeWord(localPart);
    }
}

   // Fixed generateStandardizedNames method
    generateStandardizedNames(result, files) {
        const coach = result.extracted.coach || 'UnknownCoach';
        const student = result.extracted.student || 'UnknownStudent';
        const week = result.extracted.week || '1';
        const date = this.extractDateFromFolder(result.folderName) || new Date().toISOString().split('T')[0];
        
        result.suggestedNames = [];
        
        // Map file types
        const fileTypes = {
            mp4: { suffix: '_Video', type: 'MP4' },
            m4a: { suffix: '_Audio', type: 'M4A' },
            m4: { suffix: '_Audio', type: 'M4A' },
            vtt: { suffix: '_Transcript', type: 'VTT' },
            txt: { suffix: '_Chat', type: 'CHAT' },
            json: { suffix: '_Timeline', type: 'TIMELINE' }
        };
                
        for (const file of files) {
            // Skip metadata.json files - they're not content files
            if (file.includes('metadata.json')) {
                continue;
            }
            
            let ext = '';
            let baseFileName = file;
            
            // Handle files with meeting ID appended after extension
            // Pattern: filename.extension_meetingID
            const extWithIdPattern = /\.([a-zA-Z0-9]+)_\d+$/;
            const match = file.match(extWithIdPattern);
            
            if (match) {
                // Extract the actual extension
                ext = match[1].toLowerCase();
                // Get the base filename without the extension and meeting ID
                baseFileName = file.substring(0, match.index);
            } else {
                // Standard extension extraction
                ext = path.extname(file).toLowerCase().slice(1);
                baseFileName = path.basename(file, path.extname(file));
            }
            
            // Special handling for .m4 files (audio without 'a')
            if (ext === 'm4') {
                ext = 'm4a';
            }
            
            // Handle files without extensions by trying to detect type from filename
            if (!ext) {
                if (file.toLowerCase().includes('video')) ext = 'mp4';
                else if (file.toLowerCase().includes('audio')) ext = 'm4a';
                else if (file.toLowerCase().includes('transcript')) ext = 'vtt';
                else if (file.toLowerCase().includes('chat')) ext = 'txt';
                else if (file.toLowerCase().includes('timeline')) ext = 'json';
                else {
                    // For files with no extension and no clear type, assume it's a video
                    console.log(`   ⚠️  No extension detected for: ${file}, assuming video`);
                    ext = 'mp4';
                }
            }
            
            let fileInfo = fileTypes[ext];

            // For .json files, only process if it's likely a timeline file
            if (ext === 'json' && !file.toLowerCase().includes('timeline') && !file.toLowerCase().includes('metadata')) {
                // Check if the base filename suggests it's a timeline
                // In this case, files ending with _.json are likely timeline files
                if (baseFileName.endsWith('_')) {
                    fileInfo = { suffix: '_Timeline', type: 'TIMELINE' };
                }
            }

            if (!fileInfo) {
                console.log(`   ⚠️  No fileInfo found for extension: ${ext} (file: ${file})`);
                continue;
            }

            if (fileInfo) {
                let baseName;
                
                // Handle special cases
                if (result.extracted.isSiraj) {
                    // Extract context from folder name for MISC recordings
                    const context = this.extractContextFromSirajFolder(result.folderName);
                    if (context) {
                        baseName = `MISC_Siraj_${context}_${student}`;
                    } else {
                        baseName = `MISC_Siraj_${student}`;
                    }
                } else if (result.extracted.isIvylevel) {
                    baseName = `Ivylevel_${student}`;
                } else {
                    baseName = `${coach}_${student}`;
                }
                
                if (result.extracted.hasGamePlan && !result.extracted.isSiraj) {
                    baseName += '_GamePlan';
                }
                
                if (!result.extracted.isSiraj) {
                    baseName += `_Wk${week}`;
                }
                
                baseName += `_${date}`;
                
                const standardizedName = `${baseName}${fileInfo.suffix}.${ext}`;
                
                result.suggestedNames.push({
                    original: file,
                    suggested: standardizedName,
                    type: fileInfo.type
                });
            }
        }
    }

    // Extract date from folder name
    extractDateFromFolder(folderName) {
        // Try different date patterns
        const datePatterns = [
            /(\d{4}-\d{2}-\d{2})/,
            /(\d{2}-\d{2}-\d{4})/,
            /(\d{1,2}[._-]\d{1,2}[._-]\d{2,4})/
        ];
        
        for (const pattern of datePatterns) {
            const match = folderName.match(pattern);
            if (match) {
                return match[1].replace(/[._]/g, '-');
            }
        }
        
        return null;
    }

    // Helper functions
    isLikelyCoach(username, email) {
        // DEFINITIVE RULE: If they have an @ivymentors.co or @stanford.edu email, they are a coach
        if (email && (email.includes('@ivymentors.co') || email.includes('@stanford.edu'))) {
            return true;
        }
        
        // If no email is provided, check if the username matches known coach names
        if (!email && username) {
            const firstName = username.toLowerCase().split(/[.\s_-]/)[0];
            if (this.knownCoachNames.has(firstName)) {
                return true;
            }
        }
        
        // IMPORTANT: If they have any other email domain, they are NOT a coach (likely a student)
        if (email && !email.includes('@ivymentors.co') && !email.includes('@stanford.edu')) {
            return false;
        }
        
        // If no email and name doesn't match known coaches, assume not a coach
        return false;
    }

    capitalizeWord(word) {
        // Handle hyphenated names
        if (word.includes('-')) {
            return word.split('-')
                .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
                .join('-');
        }
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    
    // Check for Siraj recordings (excluding when Siraj is a student's last name)
  // Check for Siraj recordings (excluding when Siraj is a student's last name)
    isSirajRecording(folderName) {
        const lowerName = folderName.toLowerCase();
        
        // If it doesn't contain 'siraj', it's not a Siraj recording
        if (!lowerName.includes('siraj')) {
            return false;
        }
        
        // List of known cases where Siraj is a student's last name
        const sirajStudents = ['sameeha_siraj', 'huda_siraj', 'alice_siraj'];
        
        // Check if it matches any student patterns
        for (const studentPattern of sirajStudents) {
            if (lowerName.includes(studentPattern)) {
                return false;
            }
        }
        
        // If siraj appears but not as someone's last name, it's a MISC recording
        return true;
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

    // Print results for a folder
    printFolderResults(result) {
        console.log(`\n📋 EXTRACTION RESULTS:`);
        console.log(`   Coach: ${result.extracted.coach || 'NOT FOUND'} (${(result.confidence.coach * 100).toFixed(0)}% from ${result.sources.coach || 'none'})`);
        console.log(`   Student: ${result.extracted.student || 'NOT FOUND'} (${(result.confidence.student * 100).toFixed(0)}% from ${result.sources.student || 'none'})`);
        console.log(`   Week: ${result.extracted.week || 'NOT FOUND'} (${(result.confidence.week * 100).toFixed(0)}% from ${result.sources.week || 'none'})`);
        
        if (result.confidence.coach < 0.5 || result.confidence.student < 0.5) {
            console.log(`\n   ⚠️  LOW CONFIDENCE - Would be flagged for manual review`);
        }
        
        console.log(`\n📝 SUGGESTED STANDARDIZED NAMES:`);
        for (const suggestion of result.suggestedNames) {
            console.log(`   ${suggestion.original}`);
            console.log(`   → ${suggestion.suggested}`);
            console.log('');
        }
    }

    // Print summary report
    printSummaryReport() {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`SUMMARY REPORT`);
        console.log(`${'='.repeat(80)}`);
        
        const stats = {
            total: this.results.length,
            highConfidence: 0,
            mediumConfidence: 0,
            lowConfidence: 0,
            coachFound: 0,
            studentFound: 0,
            weekFound: 0,
            sirajRecordings: 0,
            ivylevelRecordings: 0
        };
        
        for (const result of this.results) {
            const avgConfidence = (result.confidence.coach + result.confidence.student + result.confidence.week) / 3;
            
            if (avgConfidence >= 0.8) stats.highConfidence++;
            else if (avgConfidence >= 0.5) stats.mediumConfidence++;
            else stats.lowConfidence++;
            
            if (result.extracted.coach) stats.coachFound++;
            if (result.extracted.student) stats.studentFound++;
            if (result.extracted.week) stats.weekFound++;
            if (result.extracted.isSiraj) stats.sirajRecordings++;
            if (result.extracted.isIvylevel) stats.ivylevelRecordings++;
        }
        
        console.log(`\n📊 STATISTICS:`);
        console.log(`   Total recordings analyzed: ${stats.total}`);
        console.log(`   High confidence (≥80%): ${stats.highConfidence} (${((stats.highConfidence/stats.total)*100).toFixed(0)}%)`);
        console.log(`   Medium confidence (50-79%): ${stats.mediumConfidence} (${((stats.mediumConfidence/stats.total)*100).toFixed(0)}%)`);
        console.log(`   Low confidence (<50%): ${stats.lowConfidence} (${((stats.lowConfidence/stats.total)*100).toFixed(0)}%)`);
        console.log(`\n   Coach identified: ${stats.coachFound}/${stats.total} (${((stats.coachFound/stats.total)*100).toFixed(0)}%)`);
        console.log(`   Student identified: ${stats.studentFound}/${stats.total} (${((stats.studentFound/stats.total)*100).toFixed(0)}%)`);
        console.log(`   Week identified: ${stats.weekFound}/${stats.total} (${((stats.weekFound/stats.total)*100).toFixed(0)}%)`);
        console.log(`\n   Special recordings:`);
        console.log(`   - Siraj (MISC): ${stats.sirajRecordings}`);
        console.log(`   - Ivylevel: ${stats.ivylevelRecordings}`);
        
        console.log(`\n📝 LOW CONFIDENCE RECORDINGS (need manual review):`);
        for (const result of this.results) {
            if (result.confidence.coach < 0.5 || result.confidence.student < 0.5) {
                console.log(`   - ${result.folderName}`);
            }
        }
    }

    // Save detailed results to file
    async saveResultsToFile() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputFile = `recording-analysis-${timestamp}.json`;
        
        await fs.writeFile(outputFile, JSON.stringify(this.results, null, 2));
        console.log(`\n💾 Detailed results saved to: ${outputFile}`);
    }
        }

// Run the analyzer
async function main() {
    const analyzer = new LocalRecordingAnalyzer();
    const recordingsPath = '/Users/snazir/zoom-grok-local-download/zoom_recordings';
    
    console.log('🚀 Local Recording Analyzer');
    console.log('==========================');
    
    await analyzer.analyzeLocalRecordings(recordingsPath);
}

// Run if called directly
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

export default LocalRecordingAnalyzer;