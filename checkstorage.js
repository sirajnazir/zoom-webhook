#!/usr/bin/env node

require('dotenv').config();
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

async function checkDriveStorage() {
    console.log('🔍 Checking Google Drive Storage...\n');
    
    // Check if we should use impersonation
    const impersonatedUser = process.env.GOOGLE_IMPERSONATED_USER;
    let drive;
    
    if (impersonatedUser) {
        console.log(`Using domain-wide delegation to impersonate: ${impersonatedUser}\n`);
        
        // Read the service account key
        let key;
        if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64) {
            const keyJson = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64, 'base64').toString();
            key = JSON.parse(keyJson);
            require('fs').writeFileSync('./service-account-key.json', keyJson);
        } else {
            key = require('./service-account-key.json');
        }
        
        // Create JWT client with subject (impersonation)
        const authClient = new JWT({
            email: key.client_email,
            key: key.private_key,
            scopes: ['https://www.googleapis.com/auth/drive'],
            subject: impersonatedUser // This enables impersonation
        });
        
        await authClient.authorize();
        drive = google.drive({ version: 'v3', auth: authClient });
        
    } else {
        console.log('No GOOGLE_IMPERSONATED_USER set, using service account directly\n');
        
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
        drive = google.drive({ version: 'v3', auth: authClient });
    }
    
    try {
        // Get storage quota information
        const about = await drive.about.get({
            fields: 'storageQuota, user, maxUploadSize'
        });
        
        console.log('📧 Account:', about.data.user.emailAddress);
        console.log('📤 Max Upload Size:', formatBytes(about.data.maxUploadSize));
        
        const quota = about.data.storageQuota;
        console.log('\n📊 Storage Quota:');
        console.log('   Usage:', formatBytes(quota.usage));
        console.log('   Usage in Drive:', formatBytes(quota.usageInDrive));
        console.log('   Usage in Trash:', formatBytes(quota.usageInDriveTrash));
        
        if (quota.limit && quota.limit !== '-1') {
            console.log('   Limit:', formatBytes(quota.limit));
            const percentUsed = (parseInt(quota.usage) / parseInt(quota.limit) * 100).toFixed(2);
            console.log('   Percent Used:', percentUsed + '%');
            
            if (percentUsed > 90) {
                console.log('\n⚠️  WARNING: Storage is almost full!');
            }
            
            // Check if it's a regular Google account (15GB limit) or Workspace
            if (quota.limit === '16106127360') { // 15GB in bytes
                console.log('\n⚠️  This appears to be a regular Google account with 15GB limit.');
                console.log('   Consider using a Google Workspace account for more storage.');
            }
        } else {
            console.log('   Limit: Unlimited (using organization pool)');
            console.log('\n✅ Using Google Workspace organization storage pool!');
        }
        
        // List some recent files to see what's taking up space
        console.log('\n📁 Recent Large Files:');
        const fileList = await drive.files.list({
            pageSize: 10,
            orderBy: 'quotaBytesUsed desc',
            fields: 'files(name, size, createdTime, mimeType)',
            q: 'trashed = false'
        });
        
        if (fileList.data.files && fileList.data.files.length > 0) {
            fileList.data.files.forEach(file => {
                console.log(`   - ${file.name} (${formatBytes(file.size || 0)})`);
            });
        }
        
        // Check trash
        console.log('\n🗑️  Checking Trash:');
        const trashList = await drive.files.list({
            pageSize: 5,
            orderBy: 'quotaBytesUsed desc',
            fields: 'files(name, size)',
            q: 'trashed = true'
        });
        
        if (trashList.data.files && trashList.data.files.length > 0) {
            let trashSize = 0;
            trashList.data.files.forEach(file => {
                trashSize += parseInt(file.size || 0);
            });
            console.log(`   Found ${trashList.data.files.length} files in trash using ${formatBytes(trashSize)}`);
            console.log('   💡 Tip: Empty trash to free up space');
        } else {
            console.log('   Trash is empty');
        }
        
    } catch (error) {
        console.error('❌ Error checking storage:', error.message);
        if (error.errors) {
            console.error('Details:', error.errors);
        }
    }
}

function formatBytes(bytes) {
    if (!bytes || bytes === '0') return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Run the check
checkDriveStorage().catch(console.error);