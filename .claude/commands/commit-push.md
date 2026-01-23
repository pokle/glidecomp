# Commit and Push

Stage all changes, create a commit with a descriptive message, and push to the remote repository.

## Instructions

1. Run `git status` to see all changed files (do not use -uall flag)
2. Run `git diff` to see the actual changes
3. Run `git log -3 --oneline` to see recent commit message style

4. Analyze the changes and create a descriptive commit message that:
   - Summarizes the nature of the changes (feature, fix, refactor, etc.)
   - Focuses on the "why" rather than the "what"
   - Follows the repository's existing commit message style
   - Is concise (1-2 sentences)

5. Stage the relevant changed files (prefer specific files over `git add -A`)

6. Create the commit using a HEREDOC for proper formatting:
   ```
   git commit -m "$(cat <<'EOF'
   Your commit message here.

   Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
   EOF
   )"
   ```

7. Push to the remote:
   ```
   git push
   ```

8. If the push fails due to remote changes:
   - Run `git pull --rebase` to fetch and rebase on top of remote changes
   - If there are conflicts, inform the user and stop
   - If rebase succeeds, push again with `git push`

9. Report the final status to the user, including:
   - The commit hash
   - The commit message
   - Whether the push succeeded

## Important Notes

- Never use `git add -A` or `git add .` without reviewing what will be staged
- Do not commit files that contain secrets (.env, credentials, etc.)
- Do not amend existing commits unless explicitly requested
- Do not force push unless explicitly requested
