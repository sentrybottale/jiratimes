// index.js
// Jira Transition Times Extractor (Enhanced JQL Search API)

/*
 * What this script does
 * - Uses Jira Cloud API v3 enhanced JQL search at /rest/api/3/search/jql (POST)
 * - Iterates pages via nextPageToken
 * - Fetches per-issue changelog via /rest/api/3/issue/{key}/changelog (paginated)
 * - Computes time from start (created or first time in status1) to first time in status2
 * - Outputs CSV with key details + an optional custom field (Affected Customers)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { parseISO, differenceInMinutes, differenceInDays } = require('date-fns');

// ---------- Load secrets first ----------
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

// ---------- Config that depends on secrets ----------
const jiraBase = secrets.jiraUrl.replace(/\/+$/, ''); // remove trailing slash
const username = secrets.username;
const apiToken = secrets.apiToken;
const auth = Buffer.from(`${username}:${apiToken}`).toString('base64');

// ---------- Script configuration ----------
const projectName = 'Mis-Dev';
const status1 = '01 To Write';      // starting status (used if useCreatedDate=false)
const status2 = '08 Blocked';  // destination status to measure towards
const endDate = '2025-30-09';   // upper bound for status2 transitions (inclusive)
const useCreatedDate = true;    // if true, start time = issue created


// JQL to select issues
const jql = `
project = "${projectName}" AND type = Bug AND status in("01 To Write","08 Blocked") ORDER BY created ASC`;

// ---------- Endpoints ----------
const searchUrl = `${jiraBase}/rest/api/3/search/jql`; // Enhanced JQL Search
const issueChangelogUrl = (key) =>
  `${jiraBase}/rest/api/3/issue/${encodeURIComponent(key)}/changelog`;

// ---------- Helpers ----------
function printAxiosError(err) {
  if (err.response) {
    console.error('HTTP', err.response.status, err.response.statusText || '');
    console.error('URL:', err.config?.url || '(POST body request)');
    try {
      console.error('Data:', JSON.stringify(err.response.data, null, 2));
    } catch {
      console.error('Data: <unprintable>');
    }
  } else if (err.request) {
    console.error('No response received:', err.message);
  } else {
    console.error('Request setup error:', err.message);
  }
}

// Simple exponential backoff retry for transient errors
async function withRetry(fn, { retries = 3, baseDelayMs = 500 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      // Retry on 429 and 5xx
      if (attempt < retries && (status === 429 || (status >= 500 && status <= 599))) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        const retryAfterHeader = err.response?.headers?.['retry-after'];
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
        const waitMs = retryAfterMs && !isNaN(retryAfterMs) ? retryAfterMs : delay;
        console.warn(`Transient error ${status}. Retrying in ${waitMs}ms (attempt ${attempt + 1}/${retries})...`);
        await new Promise((r) => setTimeout(r, waitMs));
        attempt++;
        continue;
      }
      printAxiosError(err);
      throw err;
    }
  }
}

// ---------- Jira API calls ----------

// Enhanced JQL search (POST /rest/api/3/search/jql) with nextPageToken pagination
async function fetchIssues(nextPageToken = null) {
  const fields = [
    'key',
    'created',
    'assignee',
    'status',
    'summary',
    'priority'
  ].filter(Boolean);

  const body = {
    jql,
    fields,        // array of field ids/keys
    maxResults: 50 // page size
  };
  if (nextPageToken) body.nextPageToken = nextPageToken;

  console.log(
    `Fetching issues ${nextPageToken ? `(page token: ${nextPageToken})` : '(first page)'} with JQL: ${jql.trim()}`
  );

  const resp = await withRetry(() =>
    axios.post(
      searchUrl,
      body,
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      }
    )
  );

  // Response shape: { issues: [], isLast: boolean, nextPageToken?: string }
  return resp.data;
}

// Fetch full changelog (paginated) for a single issue
async function fetchIssueChangelog(issueKey) {
  let startAt = 0;
  const histories = [];

  while (true) {
    const url = `${issueChangelogUrl(issueKey)}?startAt=${startAt}&maxResults=100`;

    const resp = await withRetry(() =>
      axios.get(url, {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json'
        }
      })
    );

    const data = resp.data;
    const values = data.values || [];
    histories.push(...values);

    const pageSize = data.maxResults ?? values.length ?? 0;
    const total = data.total ?? startAt + pageSize;
    const isLast = data.isLast ?? (startAt + pageSize >= total);

    if (isLast) break;
    startAt += pageSize || 100;
  }

  return histories;
}

// ---------- Processing ----------
async function getAllIssues() {
  let nextPageToken = null;
  const results = [];

  do {
    const data = await fetchIssues(nextPageToken);
    const issues = data.issues || [];

    for (const issue of issues) {
      const issueKey = issue.key;
      const fields = issue.fields || {};
      const summary = fields.summary || '';
      const priority = fields.priority?.name || 'Unknown';
      const statusName = fields.status?.name || 'Unknown';
      const createdDate = fields.created || null;
      const assignee = fields.assignee?.displayName || 'Unassigned';
      const affectedCustomers = AFFECTED_CUSTOMERS_FIELD_ID ? (fields[AFFECTED_CUSTOMERS_FIELD_ID] ?? 'N/A') : 'N/A';

      // Get changelog per issue
      const histories = await fetchIssueChangelog(issueKey);

      let startTime = useCreatedDate ? createdDate : null;
      let status1Time = null;
      let status2Time = null;

      // Extract first time the issue entered status1 and status2
      for (const history of histories) {
        for (const item of history.items || []) {
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

      // Calculate "Currently in Backlog for" (days)
      const now = new Date();
      const backlogDays = startTime ? differenceInDays(now, parseISO(startTime)) : null;

      // Calculate time spent from startTime to status2Time (bounded by endDate)
      let timeSpentMinutes = null;
      let timeSpentDays = null;

      if (startTime && status2Time) {
        const startDt = parseISO(startTime);
        const status2Dt = parseISO(status2Time);
        const endDt = parseISO(endDate);
        if (!isNaN(startDt) && !isNaN(status2Dt) && !isNaN(endDt) && status2Dt <= endDt) {
          timeSpentMinutes = differenceInMinutes(status2Dt, startDt);
          timeSpentDays = differenceInDays(status2Dt, startDt);
        }
      }

      results.push({
        'Issue Key': issueKey,
        'Summary': summary.replace(/"/g, '""'),
        'Status': statusName,
        'Priority': priority,
        'Start Time': startTime,
        'Currently in Backlog for': backlogDays,
        [`${status2} Time`]: status2Time,
        'Time Spent (Minutes)': timeSpentMinutes,
        'Time Spent (Days)': timeSpentDays,
        'Assignee': assignee
      });

      console.log(`Processed ${issueKey}`);
    }

    nextPageToken = data.isLast ? null : (data.nextPageToken || null);
  } while (nextPageToken);

  return results;
}

function calculateAverageTimeSpentDays(results) {
  const valid = results.map(r => r['Time Spent (Days)']).filter(v => typeof v === 'number');
  if (valid.length === 0) return 0;
  const sum = valid.reduce((s, v) => s + v, 0);
  return sum / valid.length;
}

async function saveResultsToCsv(results) {
  const headers = [
    'Issue Key',
    'Summary',
    'Status',
    'Priority',
    'Start Time',
    'Currently in Backlog for',
    `${status2} Time`,
    'Time Spent (Minutes)',
    'Time Spent (Days)',
    'Assignee'
  ];

  const rows = results.map(r => ([
    r['Issue Key'] ?? '',
    `"${r['Summary'] ?? ''}"`,
    r['Status'] ?? '',
    r['Priority'] ?? '',
    r['Start Time'] ?? '',
    r['Currently in Backlog for'] ?? '',
    r[`${status2} Time`] ?? '',
    r['Time Spent (Minutes)'] ?? '',
    r['Time Spent (Days)'] ?? '',
    r['Assignee'] ?? ''
  ]));

  const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
  const outPath = path.join(process.cwd(), 'issue_transition_times.csv');
  fs.writeFileSync(outPath, csv);
  console.log(`Saved CSV: ${outPath}`);
}

// ---------- Main ----------
async function main() {
  try {
    const results = await getAllIssues();
    console.log(`Total issues processed: ${results.length}`);
    const avgDays = calculateAverageTimeSpentDays(results);
    console.log(`Average Time Spent (Days): ${avgDays.toFixed(2)}`);
    await saveResultsToCsv(results);
  } catch (error) {
    console.error('Fatal error:', error?.message || error);
  }
}

main();
