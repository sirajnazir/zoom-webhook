import dotenv from 'dotenv';
import BulkUploadOrganizer from './bulk-upload-organizer.js';

dotenv.config();

async function testSingleFolder() {
    const uploader = new BulkUploadOrganizer();
    
    // Initialize
    await uploader.initialize();
    
    // Test folder extraction
    const testFolders = [
        'Erin_Ye_Damaris_Mani-munoz_83494507644',
        'Jenny_Smith_John_Doe_Week_3',
        'Siraj_Review_Meeting',
        'Ivy_Mentors_Student_Session'
    ];
    
    console.log('\n📋 Testing Folder Name Extraction:\n');
    
    for (const folderName of testFolders) {
        const info = uploader.extractFolderInfo(folderName);
        console.log(`Folder: ${folderName}`);
        console.log(`  Coach: ${info.coach} (${Math.round(info.confidence.coach * 100)}%)`);
        console.log(`  Student: ${info.student} (${Math.round(info.confidence.student * 100)}%)`);
        console.log(`  Week: ${info.week}`);
        console.log(`  Special: Siraj=${info.isSiraj}, Ivylevel=${info.isIvylevel}`);
        
        // Test filename generation
        const testFileName = uploader.generateStandardizedFileName('video.mp4', info);
        console.log(`  Generated name: ${testFileName}`);
        console.log('');
    }
}

testSingleFolder().catch(console.error);