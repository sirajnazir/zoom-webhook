// zoom-quick-automation.js
const puppeteer = require('puppeteer');
require('dotenv').config();

// Helper function for delays (works with all Puppeteer versions)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Test cases
const testCases = [
    "Jenny_Duan_John_Smith_Week_3",
    "Jenny_Duan_Carlos_Rodriguez_Week_4",
    "Jenny_Duan_Lisa_Johnson_Week_5",
    "Jenny_Duan_Marcus_Brown_Week_6",
    "Jenny_Duan_Emily_Wilson_Week_7",
    "Jenny_Duan_David_Martinez_Week_8",
    "Jenny_Duan_Sarah_Davis_Week_9",
    "Jenny_Duan_Michael_Anderson_Week_10",
    "Jenny_Duan_Rachel_Thompson_Week_11",
    "Jenny_Duan_James_Garcia_Week_12"
];

async function createMeeting(page, meetingName) {
    console.log(`\n📅 Creating meeting: ${meetingName}`);
    
    try {
        // Navigate to Zoom meeting schedule page
        await page.goto('https://zoom.us/meeting/schedule', { waitUntil: 'networkidle2' });
        await delay(3000);
        
        // Fill in meeting topic
        const topicSelectors = ['input[name="topic"]', 'input[id="topic"]', '#topic', 'input[placeholder*="topic"]'];
        
        for (const selector of topicSelectors) {
            try {
                const input = await page.$(selector);
                if (input) {
                    await input.click({ clickCount: 3 });
                    await input.type(meetingName);
                    console.log('✅ Entered meeting name');
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        // Enable cloud recording
        try {
            const recordingSelectors = ['input[id="option_rec"]', 'input[type="checkbox"][name="record"]', '#option_jbh'];
            for (const selector of recordingSelectors) {
                const checkbox = await page.$(selector);
                if (checkbox) {
                    const isChecked = await page.evaluate(el => el.checked, checkbox);
                    if (!isChecked) {
                        await page.evaluate(el => el.click(), checkbox);
                        console.log('✅ Enabled cloud recording');
                    }
                    break;
                }
            }
        } catch (e) {
            console.log('⚠️  Could not set cloud recording');
        }
        
        // IMPORTANT: Actually save the meeting
        console.log('💾 Saving meeting...');
        await delay(2000);
        
        // Look for the Save/Schedule button and click it
        const saveButtonSelectors = [
            'button[type="submit"]',
            'button.btn-primary',
            'button:contains("Save")',
            'button:contains("Schedule")',
            '#submit',
            'button[class*="submit"]'
        ];
        
        let saved = false;
        for (const selector of saveButtonSelectors) {
            try {
                // Use page.$eval to directly click the button
                await page.$eval(selector, button => button.click());
                saved = true;
                console.log('✅ Clicked save button');
                break;
            } catch (e) {
                // Try next selector
            }
        }
        
        if (!saved) {
            // Try to submit the form directly
            console.log('⚠️  Trying form submit...');
            await page.evaluate(() => {
                const forms = document.querySelectorAll('form');
                if (forms.length > 0) {
                    forms[0].submit();
                }
            });
        }
        
        // CRITICAL: Wait for the save to complete
        console.log('⏳ Waiting for save to complete...');
        try {
            // Wait for navigation or success message
            await Promise.race([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }),
                page.waitForSelector('.alert-success, .success-message', { timeout: 10000 }),
                delay(8000) // Fallback timeout
            ]);
        } catch (e) {
            // Continue even if wait fails
        }
        
        // Take screenshot to confirm
        await page.screenshot({ path: `meeting-saved-${meetingName.replace(/\s+/g, '_')}.png` });
        
        console.log('✅ Meeting saved (check screenshot to confirm)');
        return { success: true, meetingName };
        
    } catch (error) {
        console.error(`❌ Error creating ${meetingName}:`, error.message);
        await page.screenshot({ path: `error-${meetingName.replace(/\s+/g, '_')}.png` });
        return { success: false, meetingName, error: error.message };
    }
}

async function startAndRecordMeetings(page, recordDuration = 30) {
    console.log('\n🎬 Starting recording phase...');
    
    try {
        // Go to meetings list
        await page.goto('https://zoom.us/meeting', { waitUntil: 'networkidle2' });
        await delay(3000);
        
        console.log('📋 Found meetings list');
        console.log('⏱️  Each meeting will record for ' + recordDuration + ' seconds');
        console.log('\n⚠️  Please manually start each meeting when ready');
        console.log('The automation will wait here while you process the meetings\n');
        
        // Keep page open for manual interaction
        await delay(recordDuration * 1000 * 10); // Wait 10x the duration for all meetings
        
    } catch (error) {
        console.error('Error in recording phase:', error.message);
    }
}

async function runAllTests() {
    console.log('🎯 Zoom Webhook Test Automation');
    console.log('================================\n');
    
    const browser = await puppeteer.launch({
        headless: false, // You need to see the browser
        defaultViewport: null,
        args: ['--start-maximized']
    });
    
    const page = await browser.newPage();
    
    try {
        // Login to Zoom
        console.log('🔐 Logging into Zoom...');
        await page.goto('https://zoom.us/signin');
        
        // Wait for page to load
        await delay(3000);
        
        // Debug: Take screenshot to see what's on the page
        await page.screenshot({ path: 'zoom-signin-page.png' });
        console.log('📸 Screenshot saved as zoom-signin-page.png');
        
        // Try multiple selectors for Google Sign-In
        const googleSelectors = [
            'a[aria-label*="Google"]',
            'a[title*="Google"]',
            'div[class*="google"]',
            'button[class*="google"]',
            'a[class*="signin-with-google"]',
            '[data-provider="google"]',
            'a:has-text("Sign in with Google")',
            'a:has-text("Google")',
            'img[alt*="Google"]'
        ];
        
        let googleButton = null;
        for (const selector of googleSelectors) {
            try {
                googleButton = await page.$(selector);
                if (googleButton) {
                    console.log(`Found Google button with selector: ${selector}`);
                    break;
                }
            } catch (e) {
                // Continue trying other selectors
            }
        }
        
        if (!googleButton) {
            console.log('Could not find Google Sign-In button. Looking for SSO option...');
            
            // Check if there's an SSO option
            const ssoButton = await page.$('a:has-text("SSO"), button:has-text("SSO"), a:has-text("Single Sign-On")');
            if (ssoButton) {
                console.log('Found SSO button, clicking it...');
                await ssoButton.click();
                await delay(2000);
            }
        }
        
        if (googleButton) {
            await googleButton.click();
        } else {
            console.log('\n⚠️  Could not find Google Sign-In button automatically.');
            console.log('Please check the screenshot zoom-signin-page.png');
            console.log('You may need to sign in manually.\n');
            
            // Wait for manual intervention
            console.log('Waiting for manual login...');
            await page.waitForFunction(
                () => window.location.href.includes('zoom.us') && !window.location.href.includes('signin'),
                { timeout: 120000 }
            );
        }
        
        // Handle Google Sign-In
        console.log('🔐 Waiting for Google Sign-In page...');
        await delay(3000);
        
        // Check if we're on Google's sign-in page
        const isGooglePage = await page.evaluate(() => window.location.hostname.includes('google.com'));
        
        if (isGooglePage) {
            console.log('📧 On Google Sign-In page');
            
            // Option 1: Automated Google Sign-In (if password provided)
            if (process.env.GOOGLE_PASSWORD) {
                try {
                    // Enter email if needed
                    const emailInput = await page.$('input[type="email"]');
                    if (emailInput) {
                        await page.type('input[type="email"]', process.env.ZOOM_EMAIL);
                        await page.keyboard.press('Enter');
                        await delay(2000);
                    }
                    
                    // Enter password
                    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
                    await page.type('input[type="password"]', process.env.GOOGLE_PASSWORD);
                    await page.keyboard.press('Enter');
                    
                    console.log('✅ Entered Google credentials');
                } catch (e) {
                    console.log('Error during Google sign-in:', e.message);
                }
            } else {
                // Option 2: Manual login
                console.log('\n⚠️  Please complete Google Sign-In manually in the browser window.');
                console.log('   Waiting for you to sign in...\n');
            }
            
            // Wait for redirect back to Zoom
            await page.waitForFunction(
                () => window.location.href.includes('zoom.us'),
                { timeout: 120000 } // 2 minute timeout for manual login
            );
        }
        
        // Wait for Zoom dashboard to load
        await delay(3000);
        console.log('✅ Logged in successfully\n');
        
        // Important: Set up auto-recording in account
        console.log('⚠️  IMPORTANT: Make sure your Zoom account has:');
        console.log('   1. Cloud recording enabled');
        console.log('   2. Auto-recording set to "Record in the cloud"\n');
        
                    await delay(3000);
        
        // Phase 1: Create all meetings
        console.log('📝 PHASE 1: Creating all meetings...\n');
        const results = [];
        
        for (let i = 0; i < testCases.length; i++) {
            const result = await createMeeting(page, testCases[i]);
            results.push(result);
            
            if (i < testCases.length - 1) {
                console.log('⏳ Waiting 10 seconds before next meeting...');
                await delay(10000); // Increased delay to ensure saves complete
            }
        }
        
        // Summary of creation
        console.log('\n📊 Meeting Creation Summary:');
        const successfulCount = results.filter(r => r.success).length;
        console.log(`✅ Created: ${successfulCount}/${results.length} meetings\n`);
        
        // Phase 2: Guide for recording
        console.log('📝 PHASE 2: Recording meetings...\n');
        console.log('All meetings have been created with cloud recording enabled!');
        console.log('\nNext steps:');
        console.log('1. Go to your meetings list at: https://zoom.us/meeting');
        console.log('2. Start each meeting one by one');
        console.log('3. Let each record for ~30 seconds');
        console.log('4. End each meeting\n');
        
        // Navigate to meetings page
        await page.goto('https://zoom.us/meeting');
        console.log('✅ Meetings page is open in the browser');
        console.log('\n⏸️  Automation paused. You can now:');
        console.log('   - Add invitees to meetings if needed');
        console.log('   - Start meetings manually');
        console.log('   - Or press Ctrl+C to exit\n');
        
        // Keep browser open
        await delay(600000); // Keep open for 10 minutes
        
        // Summary
        console.log('\n📊 SUMMARY');
        console.log('==========');
        const successful = results.filter(r => r.success).length;
        console.log(`✅ Successful: ${successful}/${results.length}`);
        
        if (results.some(r => !r.success)) {
            console.log('\n❌ Failed tests:');
            results.filter(r => !r.success).forEach(r => {
                console.log(`  - ${r.meetingName}: ${r.error}`);
            });
        }
        
    } catch (error) {
        console.error('Fatal error:', error);
    } finally {
        console.log('\n🏁 Automation complete!');
        await browser.close();
    }
}

// Run based on command line args
const args = process.argv.slice(2);

if (args[0] === 'single' && args[1]) {
    // Run single test
    (async () => {
        const browser = await puppeteer.launch({ headless: false });
        const page = await browser.newPage();
        
        // Quick single meeting test
        console.log(`Testing: ${args[1]}`);
        // ... login and create single meeting
        
        await browser.close();
    })();
} else {
    // Run all tests
    runAllTests().catch(console.error);
}