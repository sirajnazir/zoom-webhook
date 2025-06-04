import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

class ZoomMeetingTester {
    constructor() {
        this.accountId = process.env.ZOOM_ACCOUNT_ID;
        this.clientId = process.env.ZOOM_CLIENT_ID;
        this.clientSecret = process.env.ZOOM_CLIENT_SECRET;
        this.tokenCache = { token: null, expires: 0 };
        this.baseUrl = 'https://api.zoom.us/v2';
    }

    // Get Server-to-Server OAuth token
    async getAccessToken() {
        if (this.tokenCache.token && Date.now() < this.tokenCache.expires) {
            return this.tokenCache.token;
        }

        const authString = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        
        try {
            const response = await axios.post(
                'https://zoom.us/oauth/token',
                `grant_type=account_credentials&account_id=${this.accountId}`,
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `Basic ${authString}`
                    }
                }
            );

            this.tokenCache = {
                token: response.data.access_token,
                expires: Date.now() + (response.data.expires_in - 60) * 1000
            };

            return this.tokenCache.token;
        } catch (error) {
            console.error('Error getting access token:', error.response?.data || error.message);
            throw error;
        }
    }

    // Simple meeting creation instructions
    async createTestMeetingInstructions(topic, hostEmail = 'contact@ivymentors.co') {
        console.log(`\n🎯 Test Meeting Setup Instructions`);
        console.log('='.repeat(60));
        console.log(`Topic: "${topic}"`);
        console.log(`Host: ${hostEmail}`);
        console.log('\nSince Server-to-Server OAuth has limited scopes per user,');
        console.log('please create the meeting manually:\n');
        
        console.log('1. Go to https://zoom.us');
        console.log(`2. Sign in with: ${hostEmail}`);
        console.log('3. Click "Schedule a Meeting"');
        console.log(`4. Set Topic to: ${topic}`);
        console.log('5. Set Date/Time to: Now + 5 minutes');
        console.log('6. In Settings:');
        console.log('   - Enable "Record the meeting automatically"');
        console.log('   - Select "In the cloud"');
        console.log('7. Save and "Start this Meeting"');
        console.log('8. Once in meeting:');
        console.log('   - Verify recording has started (red dot)');
        console.log('   - Speak for 30-60 seconds');
        console.log('   - End meeting\n');
        console.log('The webhook will process it automatically!');
        console.log('='.repeat(60));
        
        // Save test case for tracking
        const fs = await import('fs/promises');
        const testCase = {
            topic,
            hostEmail,
            createdAt: new Date().toISOString(),
            status: 'manual_creation_required'
        };
        
        try {
            let tests = [];
            try {
                const existing = await fs.readFile('zoom-test-tracking.json', 'utf8');
                tests = JSON.parse(existing);
            } catch (e) {
                // File doesn't exist yet
            }
            tests.push(testCase);
            await fs.writeFile('zoom-test-tracking.json', JSON.stringify(tests, null, 2));
            console.log('\n✅ Test case saved to zoom-test-tracking.json');
        } catch (error) {
            console.error('Error saving test case:', error.message);
        }
    }

    // Simplified version that just gives instructions
    async createMeeting(hostEmail, meetingDetails) {
        // Due to S2S OAuth limitations, provide manual instructions
        await this.createTestMeetingInstructions(meetingDetails.topic, hostEmail);
        return null;
    }

    // Start a meeting (requires Meeting SDK, not API)
    async getMeetingInfo(meetingId) {
        const token = await this.getAccessToken();
        
        try {
            const response = await axios.get(
                `${this.baseUrl}/meetings/${meetingId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                }
            );
            return response.data;
        } catch (error) {
            console.error('Error getting meeting info:', error.response?.data || error.message);
            throw error;
        }
    }

    // Update cloud recording settings to auto-start
    async updateRecordingSettings(meetingId) {
        const token = await this.getAccessToken();
        
        try {
            const response = await axios.patch(
                `${this.baseUrl}/meetings/${meetingId}`,
                {
                    settings: {
                        auto_recording: "cloud"
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            return response.data;
        } catch (error) {
            console.error('Error updating recording settings:', error.response?.data || error.message);
            throw error;
        }
    }

    // Test scenarios
    async runTestScenarios() {
        console.log('🚀 Starting Zoom Meeting Test Scenarios\n');

        const testCases = [
            {
                name: "Ivylevel Detection Test",
                host: "contact@ivymentors.co",
                topic: "Ivylevel Onboarding - New Student",
                expected: "Coach: Ivylevel"
            },
            {
                name: "Coach Detection Test", 
                host: "siraj@ivymentors.co",
                topic: "Siraj & TestStudent - Week 5",
                expected: "Coach: Siraj"
            },
            {
                name: "Standard Coach-Student Test",
                host: "siraj@ivymentors.co",
                topic: "Jenny_Duan_John_Smith_Week_3",
                expected: "Coach: Jenny, Student: John Smith, Week: 3"
            },
            {
                name: "GamePlan Detection Test",
                host: "siraj@ivymentors.co",
                topic: "Rishi_Aarav_GamePlan_Week_2",
                expected: "GamePlan in filename"
            },
            {
                name: "Company Name Filtering Test",
                host: "siraj@ivymentors.co",
                topic: "Coach_Jenny_Ivy_Mentors_Session",
                expected: "Filter out 'Ivy Mentors'"
            },
            {
                name: "Low Confidence Test",
                host: "contact@ivymentors.co",
                topic: "Random Meeting 12345",
                expected: "Manual Review flagged"
            },
            {
                name: "MISC Siraj Test",
                host: "siraj@ivymentors.co",
                topic: "Siraj Checkpoint Meeting with Team",
                expected: "MISC_Siraj_Checkpoint_*"
            }
        ];

        const results = [];

        for (const test of testCases) {
            console.log(`\n📋 Test: ${test.name}`);
            console.log(`   Host: ${test.host}`);
            console.log(`   Topic: ${test.topic}`);
            console.log(`   Expected: ${test.expected}`);

            try {
                // Create the meeting
                const meeting = await this.createMeeting(test.host, {
                    topic: test.topic,
                    duration: 5 // 5 minute test meetings
                });

                console.log(`   ✅ Meeting created!`);
                console.log(`   Meeting ID: ${meeting.id}`);
                console.log(`   Join URL: ${meeting.join_url}`);
                console.log(`   Start URL: ${meeting.start_url}`);

                results.push({
                    test: test.name,
                    success: true,
                    meetingId: meeting.id,
                    joinUrl: meeting.join_url,
                    startUrl: meeting.start_url
                });

                // Wait a bit between meeting creations to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (error) {
                console.log(`   ❌ Failed: ${error.message}`);
                results.push({
                    test: test.name,
                    success: false,
                    error: error.message
                });
            }
        }

        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 TEST SUMMARY');
        console.log('='.repeat(60));
        
        const successful = results.filter(r => r.success).length;
        console.log(`Total Tests: ${results.length}`);
        console.log(`Successful: ${successful}`);
        console.log(`Failed: ${results.length - successful}`);

        // Save results to file
        const fs = await import('fs/promises');
        await fs.writeFile(
            'zoom-test-results.json',
            JSON.stringify(results, null, 2)
        );
        console.log('\n✅ Results saved to zoom-test-results.json');

        return results;
    }

    // Create a single test meeting
    async createTestMeeting(topic, hostEmail = 'contact@ivymentors.co') {
        await this.createTestMeetingInstructions(topic, hostEmail);
    }
}

// Main execution
async function main() {
    const tester = new ZoomMeetingTester();
    
    const args = process.argv.slice(2);
    
    if (args[0] === 'create') {
        // Create a single meeting: node zoom-test-meetings.js create "Topic Name" [hostEmail]
        const topic = args[1] || 'Test Meeting';
        const hostEmail = args[2] || 'contact@ivymentors.co';
        await tester.createTestMeeting(topic, hostEmail);
        
    } else if (args[0] === 'test-all') {
        // Run all test scenarios
        await tester.runTestScenarios();
        
    } else {
        console.log('Usage:');
        console.log('  Create single meeting: node zoom-test-meetings.js create "Topic Name" [hostEmail]');
        console.log('  Run all tests: node zoom-test-meetings.js test-all');
        console.log('\nExamples:');
        console.log('  node zoom-test-meetings.js create "Jenny_Duan_John_Smith_Week_3"');
        console.log('  node zoom-test-meetings.js create "Siraj & TestStudent" siraj@ivymentors.co');
        console.log('  node zoom-test-meetings.js test-all');
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default ZoomMeetingTester;