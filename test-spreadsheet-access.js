import dotenv from 'dotenv';
import { google } from 'googleapis';
import { promises as fs } from 'fs';

dotenv.config();

async function testSpreadsheetAccess() {
    console.log('🔍 Testing Spreadsheet Access...\n');
    
    try {
        // Load service account
        const keyContent = await fs.readFile('./service-account-key.json', 'utf8');
        const keyFile = JSON.parse(keyContent);
        
        // Authenticate
        const auth = new google.auth.GoogleAuth({
            credentials: keyFile,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        const authClient = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });
        
        const spreadsheetId = process.env.MAPPINGS_SHEET_ID;
        console.log(`Spreadsheet ID: ${spreadsheetId}`);
        
        // Test 1: Get spreadsheet metadata
        console.log('\n1️⃣ Getting spreadsheet info...');
        const metadata = await sheets.spreadsheets.get({
            spreadsheetId: spreadsheetId
        });
        console.log(`✅ Spreadsheet Title: ${metadata.data.properties.title}`);
        console.log(`   Sheets found: ${metadata.data.sheets.map(s => s.properties.title).join(', ')}`);
        
        // Test 2: Read from Mappings sheet
        console.log('\n2️⃣ Reading from Mappings sheet...');
        try {
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: spreadsheetId,
                range: 'Mappings!A1:F5'
            });
            console.log(`✅ Can read from Mappings sheet`);
            console.log(`   Rows found: ${response.data.values?.length || 0}`);
        } catch (error) {
            console.log(`❌ Cannot read from Mappings sheet: ${error.message}`);
        }
        
        // Test 3: Check if Sessions sheet exists
        console.log('\n3️⃣ Checking Sessions sheet...');
        const sessionsSheet = metadata.data.sheets.find(s => s.properties.title === 'Sessions');
        if (sessionsSheet) {
            console.log(`✅ Sessions sheet exists`);
            
            // Try to read from it
            try {
                const response = await sheets.spreadsheets.values.get({
                    spreadsheetId: spreadsheetId,
                    range: 'Sessions!A1:V1'
                });
                console.log(`   Headers: ${response.data.values?.[0]?.slice(0, 5).join(', ')}...`);
            } catch (error) {
                console.log(`   Cannot read headers: ${error.message}`);
            }
        } else {
            console.log(`⚠️  Sessions sheet does not exist`);
        }
        
        // Test 4: Try a test write to Sessions sheet
        console.log('\n4️⃣ Testing write permission...');
        try {
            const testData = [['TEST', 'TEST', 'TEST', new Date().toISOString()]];
            await sheets.spreadsheets.values.append({
                spreadsheetId: spreadsheetId,
                range: 'Sessions!A:D',
                valueInputOption: 'USER_ENTERED',
                resource: { values: testData }
            });
            console.log(`✅ Successfully wrote test data to Sessions sheet`);
            
            // Clean up test data
            const sheetData = await sheets.spreadsheets.values.get({
                spreadsheetId: spreadsheetId,
                range: 'Sessions!A:A'
            });
            const lastRow = sheetData.data.values?.length || 1;
            
            await sheets.spreadsheets.values.clear({
                spreadsheetId: spreadsheetId,
                range: `Sessions!A${lastRow}:D${lastRow}`
            });
            console.log(`   Cleaned up test data`);
        } catch (error) {
            console.log(`❌ Cannot write to Sessions sheet: ${error.message}`);
        }
        
        console.log('\n✅ Spreadsheet access test complete!');
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        if (error.code === 403) {
            console.error('\n⚠️  Permission denied. Make sure you shared the spreadsheet with the service account email.');
        }
    }
}

// Run the test
testSpreadsheetAccess();