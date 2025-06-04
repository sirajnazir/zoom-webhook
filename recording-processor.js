require('dotenv').config();
const axios = require('axios');
const { google } = require('googleapis');
const path = require('path');

// Handle SECRET_TOKEN for webhook secret
if (process.env.SECRET_TOKEN && !process.env.WEBHOOK_SECRET) {
    process.env.WEBHOOK_SECRET = process.env.SECRET_TOKEN;
}

// ADD THIS CODE BLOCK HERE - This decodes the key when the app starts
if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64) {
    const keyJson = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64, 'base64').toString();
    require('fs').writeFileSync('./service-account-key.json', keyJson);
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
        
        // Initialize Google services
        const auth = new google.auth.GoogleAuth({
            keyFile: './service-account-key.json',
            scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']
        });

        const authClient = await auth.getClient();
        this.drive = google.drive({ version: 'v3', auth: authClient });
        this.sheets = google.sheets({ version: 'v4', auth: authClient });
        
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

    // Smart logic functions from ConvertNames.py
    extractCoachFromRecordingInfo(topic, hostEmail, participantInfo = null) {
        const topicLower = topic.toLowerCase();
        
        // Pattern 1: Look for coach patterns in topic
        const coachPatterns = [
            /coach[_\s]+([a-z]+)/i,
            /new[_\s]+coach[_\s]+([a-z]+)/i,
            /coach[_\s]*[:]\s*([a-z]+)/i,
            /w[_\s]*(?:ith)?[_\s]*([a-z]+)/i
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
        
        // Pattern 2: Look for known coach names in topic
        const words = topicLower.split(/[_\s\-]+/);
        for (const word of words) {
            const cleanWord = word.replace(/[^a-z]/g, '');
            if (this.knownCoachNames.has(cleanWord)) {
                return this.capitalizeWord(cleanWord);
            }
        }
        
        // Pattern 3: Check host email
        if (hostEmail && this.isCoachEmail(hostEmail)) {
            const emailName = hostEmail.split('@')[0];
            const firstName = emailName.split('.')[0];
            if (this.knownCoachNames.has(firstName.toLowerCase())) {
                return this.capitalizeWord(firstName);
            }
        }
        
        // Pattern 4: Check participant info if available
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
        // Pattern: Look for student names in topic
        const patterns = [
            /____([a-z]+)___/i,
            /___([a-z]+(?:_[a-z]+)*)___/i,
            /__([a-z]+(?:_[a-z]+)*)__/i,
            /student[_\s]+([a-z]+(?:_[a-z]+)*)/i
        ];
        
        for (const pattern of patterns) {
            const match = topic.match(pattern);
            if (match) {
                const studentName = match[1];
                if (!coach || studentName.toLowerCase() !== coach.toLowerCase()) {
                    return studentName.split('_').map(w => this.capitalizeWord(w)).join(' ');
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
                    return this.capitalizeWord(studentName);
                }
            }
        }
        
        return null;
    }

    extractWeekNumber(topic) {
        const weekPatterns = [
            /week[_\s]+(\d+)/i,
            /wk[_\s]+(\d+)/i,
            /week[_\s]*#[_\s]*(\d+)/i,
            /wk[_\s]*#[_\s]*(\d+)/i
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
            /\bgameplan\b/i
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

    async processWebhookPayload(payload) {
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
        
        console.log(`✓ Created temp folder: TEMP_ZOOM_RECORDINGS/${dateFolder}/${tempFolderName}`);
        
        // Get token for downloading
        const token = await this.getZoomToken();
        
        // Step 2: Download and store all files in temp folder first
        const tempFiles = [];
        const recordingFiles = recording.recording_files || [];
        
        for (const file of recordingFiles) {
            if (file.status !== 'completed') continue;
            
            try {
                const fileInfo = await this.downloadAndStoreFile(
                    file,
                    tempRecordingFolderId,
                    token,
                    file.file_type
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
            }
        }
        
        console.log(`✓ Downloaded ${tempFiles.length} files to temp folder`);
        
        // Step 3: Apply smart logic to identify coach and student
        let coach = null;
        let student = null;
        let weekNumber = null;
        let hasGamePlan = false;
        let isSiraj = false;
        
        // Check if this is a Siraj recording
        if (this.isSirajRecording(recording.topic)) {
            isSiraj = true;
            coach = "Siraj";
            console.log("✓ Detected as Siraj (MISC) recording");
        } else {
            // Extract from recording info using smart logic
            coach = this.extractCoachFromRecordingInfo(
                recording.topic,
                recording.host_email,
                recording.participants
            );
            
            student = this.extractStudentFromRecordingInfo(recording.topic, coach);
            
            // Extract week number and game plan indicator
            weekNumber = this.extractWeekNumber(recording.topic);
            hasGamePlan = this.hasGamePlanIndicator(recording.topic);
        }
        
        // If we couldn't extract coach/student from topic, try mappings
        if (!student && !isSiraj) {
            const studentEmail = this.identifyStudent(recording);
            if (studentEmail) {
                const studentInfo = this.studentMappings.get(studentEmail);
                if (studentInfo) {
                    student = studentInfo.name;
                    if (!coach) {
                        coach = studentInfo.coach;
                    }
                    if (!weekNumber) {
                        weekNumber = this.calculateWeekNumber(studentEmail, recording.start_time);
                    }
                }
            }
        }
        
        // Set defaults if still missing
        if (!coach && !isSiraj) coach = 'Unknown Coach';
        if (!student && !isSiraj) student = 'Unknown Student';
        
        const studentEmail = this.identifyStudent(recording) || 'unknown@email.com';
        const studentInfo = this.studentMappings.get(studentEmail) || {
            name: student,
            coach: coach,
            program: 'Unknown Program',
            startDate: new Date().toISOString().split('T')[0]
        };
        
        if (!weekNumber && !isSiraj) {
            weekNumber = this.calculateWeekNumber(studentEmail, recording.start_time);
        }
        
        console.log(`✓ Identified: Coach=${coach}, Student=${student}, Week=${weekNumber}, GamePlan=${hasGamePlan}`);
        
        // Step 4: Create final folder structure
        const folders = await this.createFolderStructure(
            studentEmail,
            coach,
            studentInfo.program,
            weekNumber
        );
        
        // Step 5: Copy files from temp to final locations with standardized names
        const processedFiles = {};
        
        for (const tempFile of tempFiles) {
            const standardizedName = this.generateStandardizedFileName(
                tempFile.type,
                coach,
                student,
                weekNumber,
                dateFolder,
                recording.id || recording.uuid,
                hasGamePlan,
                isSiraj
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
        
        // Update tracking spreadsheet
        await this.updateTrackingSpreadsheet({
            meetingId: recording.id || recording.uuid,
            topic: recording.topic,
            student: student,
            studentEmail: studentEmail,
            coach: coach,
            program: studentInfo.program,
            week: weekNumber,
            date: recording.start_time,
            duration: recording.duration,
            files: processedFiles,
            host: recording.host_email || '',
            tempFolderPath: `TEMP_ZOOM_RECORDINGS/${dateFolder}/${tempFolderName}`
        });
        
        console.log(`✅ Successfully processed recording for ${student}`);
        
        return {
            success: true,
            student: student,
            coach: coach,
            week: weekNumber,
            filesProcessed: tempFiles.length,
            files: processedFiles,
            tempFolder: `TEMP_ZOOM_RECORDINGS/${dateFolder}/${tempFolderName}`
        };
    }

    async downloadAndStoreFile(file, folderId, token, fileType) {
        console.log(`  📥 Downloading ${fileType}...`);
        
        // Download with retries
        let stream;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const response = await axios.get(file.download_url, {
                    headers: { 'Authorization': `Bearer ${token}` },
                    responseType: 'stream',
                    timeout: 300000
                });
                stream = response.data;
                break;
            } catch (error) {
                if (attempt === 3) throw error;
                console.log(`  Retry ${attempt}/3 for ${fileType}`);
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
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
            baseName = `${baseName}_${meetingId}`;
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

    async updateTrackingSpreadsheet(sessionData) {
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
                sessionData.tempFolderPath || ''
            ]];

            await this.sheets.spreadsheets.values.append({
                spreadsheetId: this.mappingsSheetId,
                range: 'Sessions!A:O',
                valueInputOption: 'USER_ENTERED',
                resource: { values }
            });
            
            console.log('✓ Tracking spreadsheet updated');
        } catch (error) {
            console.error('Error updating spreadsheet:', error.message);
        }
    }
}

// Export for use in other files
module.exports = RecordingProcessor;

// If run directly, process from command line
if (require.main === module) {
    const processor = new RecordingProcessor();
    
    // Example: node recording-processor.js process-webhook '{"object": {...}}'
    if (process.argv[2] === 'process-webhook' && process.argv[3]) {
        const payload = JSON.parse(process.argv[3]);
        processor.processWebhookPayload(payload)
            .then(result => {
                console.log('Result:', result);
                process.exit(0);
            })
            .catch(error => {
                console.error('Error:', error);
                process.exit(1);
            });
    } else {
        console.log('Usage: node recording-processor.js process-webhook \'{"object": {...}}\'');
    }
}