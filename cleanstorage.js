#!/usr/bin/env node

require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function askQuestion(question) {
    return new Promise(resolve => {
        rl.question(question, resolve);
    });
}

async function driveCleanup() {
    console.log('🧹 Google Drive Cleanup Tool\n');
    
    // Decode service account key if needed
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64) {
        const keyJson = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64, 'base64').toString();
        require('fs').writeFileSync('./service-account-key.json', keyJson);
    }
    
    // Initialize Google services
    const auth = new google.auth.GoogleAuth({
        keyFile: './service-account-key.json',
        scopes: ['https://www.googleapis.com/auth/drive']
    });

    const authClient = await auth.getClient();
    const drive = google.drive({ version: 'v3', auth: authClient });
    
    try {
        // Option 1: Empty Trash
        console.log('1️⃣  Empty Trash');
        const trashList = await drive.files.list({
            pageSize: 1000,
            fields: 'files(id, name, size)',
            q: 'trashed = true'
        });
        
        if (trashList.data.files && trashList.data.files.length > 0) {
            let trashSize = 0;
            trashList.data.files.forEach(file => {
                trashSize += parseInt(file.size || 0);
            });
            console.log(`   Found ${trashList.data.files.length} files in trash using ${formatBytes(trashSize)}`);
            
            const answer = await askQuestion('   Empty trash? (yes/no): ');
            if (answer.toLowerCase() === 'yes') {
                console.log('   Emptying trash...');
                await drive.files.emptyTrash();
                console.log('   ✓ Trash emptied!');
            }
        } else {
            console.log('   Trash is already empty');
        }
        
        // Option 2: Find and remove duplicates in TEMP_ZOOM_RECORDINGS
        console.log('\n2️⃣  Find Duplicates in TEMP_ZOOM_RECORDINGS');
        
        // First, find TEMP_ZOOM_RECORDINGS folder
        const tempFolderQuery = await drive.files.list({
            q: `name = 'TEMP_ZOOM_RECORDINGS' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id, name)'
        });
        
        if (tempFolderQuery.data.files && tempFolderQuery.data.files.length > 0) {
            const tempFolderId = tempFolderQuery.data.files[0].id;
            console.log('   Found TEMP_ZOOM_RECORDINGS folder');
            
            // Get all files recursively
            const allFiles = await getAllFilesRecursively(drive, tempFolderId);
            console.log(`   Total files found: ${allFiles.length}`);
            
            // Find duplicates by name
            const filesByName = {};
            allFiles.forEach(file => {
                if (!filesByName[file.name]) {
                    filesByName[file.name] = [];
                }
                filesByName[file.name].push(file);
            });
            
            const duplicates = Object.entries(filesByName).filter(([name, files]) => files.length > 1);
            
            if (duplicates.length > 0) {
                console.log(`   Found ${duplicates.length} sets of duplicate files`);
                let duplicateSize = 0;
                duplicates.forEach(([name, files]) => {
                    files.slice(1).forEach(file => {
                        duplicateSize += parseInt(file.size || 0);
                    });
                });
                console.log(`   Space that can be freed: ${formatBytes(duplicateSize)}`);
                
                const answer = await askQuestion('   Remove duplicates (keep newest)? (yes/no): ');
                if (answer.toLowerCase() === 'yes') {
                    for (const [name, files] of duplicates) {
                        // Sort by created time, keep newest
                        files.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
                        
                        // Delete all but the newest
                        for (let i = 1; i < files.length; i++) {
                            await drive.files.delete({ fileId: files[i].id });
                        }
                    }
                    console.log('   ✓ Duplicates removed!');
                }
            } else {
                console.log('   No duplicates found');
            }
        }
        
        // Option 3: Archive old recordings
        console.log('\n3️⃣  Archive Old Recordings');
        console.log('   This would move recordings older than 6 months to an Archive folder');
        console.log('   (Not implemented in this version)');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.errors) {
            console.error('Details:', error.errors);
        }
    } finally {
        rl.close();
    }
}

async function getAllFilesRecursively(drive, folderId, files = []) {
    let pageToken = null;
    
    do {
        const response = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'nextPageToken, files(id, name, size, createdTime, mimeType)',
            pageSize: 1000,
            pageToken: pageToken
        });
        
        for (const file of response.data.files) {
            if (file.mimeType === 'application/vnd.google-apps.folder') {
                // Recursively get files from subfolder
                await getAllFilesRecursively(drive, file.id, files);
            } else {
                files.push(file);
            }
        }
        
        pageToken = response.data.nextPageToken;
    } while (pageToken);
    
    return files;
}

function formatBytes(bytes) {
    if (!bytes || bytes === '0') return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Run the cleanup
driveCleanup().catch(console.error);