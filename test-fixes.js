import dotenv from 'dotenv';
import BulkUploadOrganizer from './bulk-upload-organizer.js';

dotenv.config();

async function testFixes() {
    const uploader = new BulkUploadOrganizer();
    
    console.log('🧪 Testing fixes...\n');
    
    // Test 1: Initialize and check spreadsheet access
    await uploader.initialize();
    
    // Test 2: Process a few folders with dry run
    process.env.DRY_RUN = 'true';
    process.env.TEST_MODE = 'true';
    
    await uploader.processAllRecordings();
}

testFixes().catch(console.error);