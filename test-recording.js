// test-recording.js - Local test script for the enhanced recording processor
require('dotenv').config();
const RecordingProcessor = require('./recording-processor');

// Sample webhook payload - modify this to match your actual recordings
const testPayload = {
    "object": {
        "id": "test123456",
        "uuid": "test-uuid-123",
        "host_email": "jenny@ivymentors.co",
        "topic": "Coach Jenny Week 3 - Student_Name Meeting",
        "start_time": "2024-03-15T10:00:00Z",
        "duration": 60,
        "recording_files": [
            {
                "id": "file1",
                "file_type": "MP4",
                "file_size": 100000,
                "download_url": "https://zoom.us/rec/download/test-video",
                "status": "completed"
            },
            {
                "id": "file2",
                "file_type": "TRANSCRIPT",
                "file_size": 5000,
                "download_url": "https://zoom.us/rec/download/test-transcript",
                "status": "completed"
            },
            {
                "id": "file3",
                "file_type": "TIMELINE",
                "file_size": 2000,
                "download_url": "https://zoom.us/rec/download/test-timeline",
                "status": "completed"
            }
        ]
    }
};

// Test cases with different confidence levels
const testCases = [
    {
        name: "High Confidence Test",
        payload: {
            ...testPayload,
            object: {
                ...testPayload.object,
                topic: "Coach Jenny - John_Smith Week 5 Meeting",
                host_email: "jenny@ivymentors.co"
            }
        }
    },
    {
        name: "Low Confidence Test",
        payload: {
            ...testPayload,
            object: {
                ...testPayload.object,
                topic: "Weekly Meeting 123", // Vague topic
                host_email: "unknown@email.com"
            }
        }
    },
    {
        name: "Timeline Test",
        payload: {
            ...testPayload,
            object: {
                ...testPayload.object,
                topic: "Session Recording", // Will need timeline parsing
                recording_files: [
                    ...testPayload.object.recording_files,
                    {
                        "id": "file4",
                        "file_type": "CHAT",
                        "file_size": 1000,
                        "download_url": "https://zoom.us/rec/download/test-chat",
                        "status": "completed"
                    }
                ]
            }
        }
    }
];

async function runTests() {
    const processor = new RecordingProcessor();
    
    console.log('🧪 Starting Local Tests...\n');
    
    for (const testCase of testCases) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📋 Test: ${testCase.name}`);
        console.log(`${'='.repeat(60)}`);
        
        try {
            // For local testing, we'll skip actual file downloads
            // Comment out the next line to test with real downloads
            process.env.SKIP_DOWNLOADS = 'true';
            
            const result = await processor.processWebhookPayload(testCase.payload);
            
            console.log('\n✅ Test Result:');
            console.log(`   Student: ${result.student}`);
            console.log(`   Coach: ${result.coach}`);
            console.log(`   Week: ${result.week}`);
            console.log(`   Confidence:`, result.confidence);
            console.log(`   Sources:`, result.sources);
            
        } catch (error) {
            console.error('\n❌ Test Failed:', error.message);
            console.error('Stack:', error.stack);
        }
    }
    
    console.log('\n\n🏁 All tests completed!');
    
    // Check the Google Sheet
    console.log('\n📊 Check your Google Sheet:');
    console.log('   - Sessions tab for new entries');
    console.log('   - Manual_Review tab for low-confidence recordings');
}

// Run the tests
runTests();