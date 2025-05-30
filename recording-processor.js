require('dotenv').config();
const axios = require('axios');
const { google } = require('googleapis');

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
    // ... rest of the code

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
        const mainFolders = ['By Program', 'By Coach', 'By Student', 'Master Database'];
        
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

    async processWebhookPayload(payload) {
        await this.initialize();
        
        const recording = payload.object || payload;
        console.log(`\n📹 Processing recording: ${recording.topic}`);
        
        // Identify student
        const studentEmail = this.identifyStudent(recording);
        if (!studentEmail) {
            console.warn(`❌ Could not identify student for: ${recording.topic}`);
            return { 
                success: false, 
                reason: 'unidentified_student',
                topic: recording.topic 
            };
        }

        const studentInfo = this.studentMappings.get(studentEmail);
        const weekNumber = this.calculateWeekNumber(studentEmail, recording.start_time);
        
        console.log(`✓ Identified: ${studentInfo.name} (${studentEmail}) - Week ${weekNumber}`);

        // Create folder structure
        const folders = await this.createFolderStructure(
            studentEmail,
            studentInfo.coach,
            studentInfo.program,
            weekNumber
        );

        // Get token for downloading
        const token = await this.getZoomToken();

        // Process each recording file
        const processedFiles = {};
        const recordingFiles = recording.recording_files || [];
        let successCount = 0;
        
        for (const file of recordingFiles) {
            if (file.status !== 'completed') continue;

            try {
                const fileInfo = await this.processRecordingFile(
                    file,
                    folders,
                    studentInfo,
                    weekNumber,
                    token
                );
                
                if (fileInfo) {
                    processedFiles[file.file_type.toLowerCase()] = fileInfo.webViewLink;
                    successCount++;
                }
            } catch (error) {
                console.error(`Error processing ${file.file_type}:`, error.message);
            }
        }

        // Update tracking spreadsheet
        await this.updateTrackingSpreadsheet({
            meetingId: recording.id || recording.uuid,
            topic: recording.topic,
            student: studentInfo.name,
            studentEmail: studentEmail,
            coach: studentInfo.coach,
            program: studentInfo.program,
            week: weekNumber,
            date: recording.start_time,
            duration: recording.duration,
            files: processedFiles,
            host: recording.host_email || ''
        });

        console.log(`✅ Successfully processed ${successCount} files for ${studentInfo.name}`);
        
        return { 
            success: true, 
            student: studentInfo.name, 
            week: weekNumber,
            filesProcessed: successCount,
            files: processedFiles
        };
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

    async processRecordingFile(file, folders, studentInfo, weekNumber, token) {
        let fileName, mimeType;
        
        switch (file.file_type) {
            case 'MP4':
                fileName = `${studentInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}_Week${weekNumber}_Video.mp4`;
                mimeType = 'video/mp4';
                break;
            case 'M4A':
                fileName = `${studentInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}_Week${weekNumber}_Audio.m4a`;
                mimeType = 'audio/mp4';
                break;
            case 'TRANSCRIPT':
            case 'VTT':
                fileName = `${studentInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}_Week${weekNumber}_Transcript.vtt`;
                mimeType = 'text/vtt';
                break;
            case 'CHAT':
                fileName = `${studentInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}_Week${weekNumber}_Chat.txt`;
                mimeType = 'text/plain';
                break;
            default:
                console.log(`Skipping file type: ${file.file_type}`);
                return null;
        }

        console.log(`  📥 Downloading ${fileName}...`);

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
                console.log(`  Retry ${attempt}/3 for ${fileName}`);
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
        }

        // Upload to primary location (By Student)
        console.log(`  📤 Uploading ${fileName}...`);
        const upload = await this.uploadToDrive(stream, fileName, folders.byStudent, mimeType);
        
        // Copy to other locations instead of re-uploading
        await Promise.all([
            this.copyFile(upload.id, folders.byProgram, fileName),
            this.copyFile(upload.id, folders.byCoach, fileName)
        ]);

        console.log(`  ✓ ${fileName} uploaded successfully`);
        return upload;
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
            fields: 'id, webViewLink'
        });

        return response.data;
    }

    async copyFile(fileId, targetFolderId, fileName) {
        try {
            await this.drive.files.copy({
                fileId: fileId,
                resource: {
                    name: fileName,
                    parents: [targetFolderId]
                }
            });
        } catch (error) {
            console.error(`Error copying file: ${error.message}`);
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
                new Date().toISOString()
            ]];

            await this.sheets.spreadsheets.values.append({
                spreadsheetId: this.mappingsSheetId,
                range: 'Sessions!A:N',
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