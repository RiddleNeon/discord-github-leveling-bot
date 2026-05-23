# discord-github-leveling-bot

A Discord bot that receives GitHub push events, posts rich commit embeds, and awards XP/levels to linked users.

## Setup

1. Install dependencies.
2. Create a `.env` file.
3. Start the bot.

Example `.env`:

```
DISCORD_TOKEN=your_discord_bot_token
_GITHUB_TOKEN=your_github_token_optional
_GITHUB_WEBHOOK_SECRET=your_webhook_secret_optional
PORT=3000
```

`_GITHUB_TOKEN` is optional but required for full commit stats (additions, deletions, top files).

## Commands

Admin commands:

- `!setcommitschannel #channel`
- `!setleaderboardchannel #channel`
- `!setprefix <newPrefix>`
- `!addxp @user <amount>`
- `!debugconfig`

User commands:

- `!linkgithub <githubUsername>`
- `!unlinkgithub`
- `!leaderboard`
- `!help`

## GitHub Webhook

Configure a GitHub webhook for your repository:

- Payload URL: `https://your-host:3000/github`
- Content type: `application/json`
- Secret: same as `_GITHUB_WEBHOOK_SECRET`
- Events: `Push`

## Optional GitHub Actions workflow

You can also post the push payload via GitHub Actions if a webhook is not possible. Create `.github/workflows/discord-commit-webhook.yml`:

```
name: Discord Commit Webhook
on:
  push:
jobs:
  notify:
	runs-on: ubuntu-latest
	steps:
	  - name: Send payload
		run: |
		  curl -X POST \
			-H "Content-Type: application/json" \
			-H "X-GitHub-Event: push" \
			-d '${{ toJson(github.event) }}' \
			${{ secrets.DISCORD_WEBHOOK_ENDPOINT }}
```

Store `DISCORD_WEBHOOK_ENDPOINT` as a repo secret, for example `https://your-host:3000/github`.

## XP / Leveling

- XP gain per commit: `additions + deletions * 0.6`
- XP required for next level grows by `level^1.45`
- Levels are shown in the leaderboard embed
