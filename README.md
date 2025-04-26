# Jira Transition Times Extractor

This Node.js script fetches issues from Jira, calculates the time spent between two specified statuses (e.g., "Backlog" to "In Progress"), and exports the results to a CSV file. It also computes the average time spent in days for issues that transitioned between the statuses.

## Features
- Fetches Jira issues using the Jira REST API.
- Extracts transition times between two statuses from the issue changelog.
- Supports using the issue's creation date as the start time (optional).
- Outputs results to a CSV file (`issue_transition_times.csv`).
- Calculates the average time spent in days for issues with valid transitions.
- Includes issue details like summary, status, priority, assignee, and a custom field (e.g., "Affected Customers").

## Prerequisites
- **Node.js** (v14 or higher recommended).
- A Jira account with API access.
- A Jira API token (generate one from your Jira account settings).
- Git (to clone the repository).

## Setup
1. **Clone the Repository**:
   ```bash
   git clone git@github.com:sentrybottle/jiratimes.git
   cd jiratimes