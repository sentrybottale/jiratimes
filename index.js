const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { parseISO, differenceInMinutes, differenceInDays, formatISO } = require('date-fns');

// Load secrets from the secrets directory
const secretsPath = path.join(__dirname, 'secrets', 'secrets.json');
let secrets;
try {
    secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
    if (!secrets.jiraUrl || !secrets.username || !secrets.apiToken) {
        throw new Error('secrets.json is missing required fields (jiraUrl, username, apiToken)');
    }
} catch (error) {
    console.error('Error reading or validating secrets.json:', error.message);
    process.exit(1);
}

// Jira instance and authentication
const jiraUrl = secrets.jiraUrl;
const username = secrets.username;
const apiToken = secrets.apiToken;

// Define variables for the project name, status names, and dates
const projectName = 'Some Project Name';
const status1 = 'Backlog';
const status2 = 'In Progress';
const startDate1 = '2023-01-01'; // Start date
const endDate = '2025-01-01'; // End date for status2
const useCreatedDate = true; // Set to true to use issue created date as start date

// JQL query to get issues that match the criteria
const jql = `
project = "${projectName}" AND type = Bug AND status in(Backlog,Planning,"In Progress") ORDER BY created ASC`;

// API endpoint for search
const searchUrl = `${jiraUrl}/rest/api/2/search`;
const auth = Buffer.from(`${username}:${apiToken}`).toString('base64');

// Function to fetch issues from Jira
async function fetchIssues(startAt = 0) {
    const params = {
        jql: jql,
        expand: 'changelog',
        fields: 'key,changelog,created,assignee,customfield_999,status,summary,priority', 
        startAt: startAt,
        maxResults: 50
    };

    console.log(`Fetching issues starting at ${startAt} with JQL: ${jql}`);
    const response = await axios.get(searchUrl, {
        headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json'
        },
        params: params
    });

    return response.data;
}

async function getAllIssues() {
    let startAt = 0;
    let total = 0;
    const results = [];

    do {
        const data = await fetchIssues(startAt);
        total = data.total;
        const issues = data.issues;

        // Process each issue to get transition timestamps
        for (const issue of issues) {
            console.log(`All Fields for ${issue.key}:`, issue.fields); // Log all fields for inspection
            
            const issueKey = issue.key;
            const summary = issue.fields.summary;
            const priority = issue.fields.priority ? issue.fields.priority.name : 'Unknown';
            const status = issue.fields.status ? issue.fields.status.name : 'Unknown';
            const changelog = issue.changelog.histories;
            const createdDate = issue.fields.created;
            const assignee = issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned';
            const affectedCustomers = issue.fields.customfield_999 || 'N/A'; // Replace 'customfield_XXXXX' with the actual field ID for example "Affected customers[Number]"

            console.log(`Affected Customers for ${issueKey}:`, affectedCustomers);
            console.log(`Processing issue: ${issueKey}`);

            let startTime = useCreatedDate ? createdDate : null;
            let status1Time = null;
            let status2Time = null;

            // Extract relevant timestamps from changelog
            for (const history of changelog) {
                for (const item of history.items) {
                    if (item.field === 'status') {
                        if (item.toString === status1 && !status1Time) {
                            status1Time = history.created;
                        }
                        if (item.toString === status2 && !status2Time) {
                            status2Time = history.created;
                        }
                    }
                }
            }

            if (!useCreatedDate && status1Time) {
                startTime = status1Time;
            }

            // Calculate "Currently in Backlog for" in days
            let currentTime = new Date();
            let backlogDays = startTime ? differenceInDays(currentTime, parseISO(startTime)) : null;

            console.log(`Issue: ${issueKey}, Start Time: ${startTime}, Currently in Backlog for: ${backlogDays} days, ${status2} Time: ${status2Time}, Assignee: ${assignee}, Affected Customers: ${affectedCustomers}`);

            // Calculate time spent if both timestamps are available
            let timeSpentMinutes = null;
            let timeSpentDays = null;
            if (startTime && status2Time) {
                const startDt = parseISO(startTime);
                const status2Dt = parseISO(status2Time);

                // Ensure the done date is before the end date
                if (status2Dt <= parseISO(endDate)) {
                    timeSpentMinutes = differenceInMinutes(status2Dt, startDt);
                    timeSpentDays = differenceInDays(status2Dt, startDt);
                }
            }

            // Add the issue to the results, even if some times are missing
            results.push({
                'Issue Key': issueKey,
                'Summary': summary ? summary.replace(/"/g, '""') : '',  // Escape internal double quotes
                'Status': status,
                'Priority': priority,
                'Start Time': startTime,
                'Currently in Backlog for': backlogDays,
                [`${status2} Time`]: status2Time,
                'Time Spent (Minutes)': timeSpentMinutes,
                'Time Spent (Days)': timeSpentDays,
                'Assignee': assignee,
                'Affected Customers': affectedCustomers,
            });

            console.log(`Processed issue: ${issueKey}`);
        }

        startAt += 50;
    } while (startAt < total);

    return results;
}

function calculateAverageTimeSpentDays(results) {
    if (results.length === 0) return 0;
    const totalDays = results.reduce((sum, result) => sum + (result['Time Spent (Days)'] || 0), 0);
    return totalDays / results.length;
}

async function saveResultsToCsv(results) {
    const csvData = [
        ['Issue Key','Summary', 'Status', 'Priority', 'Start Time', 'Currently in Backlog for', `${status2} Time`, 'Time Spent (Minutes)', 'Time Spent (Days)', 'Assignee', 'Affected Customers'],
        ...results.map(result => [
            result['Issue Key'],
            `"${result['Summary'] || ''}"`,
            result['Status'] || '',
            result['Priority'] || '',
            result['Start Time'] || '',
            result['Currently in Backlog for'] || '',
            result[`${status2} Time`] || '',
            result['Time Spent (Minutes)'] || '',
            result['Time Spent (Days)'] || '',
            result['Assignee'] || '',
            result['Affected Customers'] || ''
        ])
    ].map(row => row.join(',')).join('\n');

    fs.writeFileSync('issue_transition_times.csv', csvData);
}

async function main() {
    try {
        const results = await getAllIssues();
        console.log(`Total issues processed: ${results.length}`);
        results.forEach(result => console.log(result));
        await saveResultsToCsv(results);

        // Calculate and print the average time spent in days
        const averageTimeSpentDays = calculateAverageTimeSpentDays(results);
        console.log(`Average Time Spent (Days): ${averageTimeSpentDays.toFixed(2)}`);
    } catch (error) {
        console.error('Error fetching issues from Jira:', error);
    }
}

// Run the script
main();
