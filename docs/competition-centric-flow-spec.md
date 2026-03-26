
# Competition Centric user interface

This is a specification for a competition centric user interface for glidecomp.

Version: 1.0
Date: 2026-03-26

## Entity design

- comp: Represents a competition
  - comp_id (a unique lowercase alpha string code of minimum 4 letters. E.g. 'face')
  - name (public name)
  - creation_date
  - category (One of 'hg', or 'pg')
  - test (boolean - indicates that this is a test and should not be shown to the public)
  - admin (list of better-auth admin email addresses. Initialised to creator's email)
  - gap_params (GAP scoring parameter object)
- task: Represents a task within a competition
  - task_id (a unique lowercase alpha string code of minimum 4 letters. E.g. 'face')
  - comp_id (reference to an existing comp that owns this task)
  - name (public name)
  - creation_date
  - category (user assignable string. E.g. 'novice', 'vetran', 'pro')

Store these as D1 tables.

When a user's account is deleted, all the entities above MUST be deleted if they are the last remaining admin.

## File storage design

- IGC, and XCTSK files are to be stored on Cloudflare R2.
- Compress files in the browser before sending them to the cloudflare worker

## Cloudflare worker API design

Use a cloudflare worker called competition-api.

It should ensure all requests are from authenticated callers.

## URL design

- `/comp`
  - Lists all the competitions that you have admin access to (including test competitions)
  - Also lists all recently created non-test competitions (created within the last 24 months)
- `/comp/{comp_id}`: Competition page for existing competition.
- `/comp/{comp_id}/task/{task_id}`: Task page for existing tasks.
- `/scores`: public scores page. Query params: comp_id

# Focus related design decisions

- It should not display the map. This is about scores.
- It should focus on a very simple job to be done: Quickly work out the scores for a competition task.

# Security design 
- Ensure that all user entered fields are sanitised before storing them.
- Ensure only admins of a comp can modify it and any associated child data (task, igc, xctsk, …)
- Ensure only authenticated users can visit all pages except for the score page.
- The score page is the only public page. 
- Enforce limits on the size of user supplied data to avoid abuse
  - Limit the size of user entered text fields to 128 chars (approx)
  - Limit the size of IGC files uploaded and stored to 5mb each.
  - Limit the size of XCTSK files uploaded and stored to 1mb each.
  - Limit the maximum number of XCTSK files to one per task.
  - Limit the maximum number of IGC files uploaded to a task to 250
  - Limit the maximum number of tasks per comp to 50
  - Limit the maximum number of competitions per account to 50

# UX Flow (draft)

Main flow to create or view competitions:
1. Log in using Google Auth if not already logged in.
2. A competition dashboard lists all past competitions created by user. Clicking on the competition takes you to the competition's page.
3. Button to create a competition - Give it a name (E.g. "Bells Beach Run 2026"). Initially competitions are can only be administered by the creator. The creator can delegate the competition to more admins by adding (or removing) google auth email addresses. No emails are sent. When a delegate logs in to the competition page, they see the same 
4. Start by entering the name of the competition task (e.g. Bells Beach Run 2026 #7). This should create a unique shareable URL that can be shared to other pilots - who can add their own tracks if needed. The URL should not be guessable. A 6 letter alpha only code should be enough.
5. Configure the Competition settings (HG/PG, Nominal distance, time, etc…)
6. Define the task (UI to define the task, or import xctsk file, or import from xcontest api).
7. Upload IGC files

