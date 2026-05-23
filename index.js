const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
require('dotenv').config();

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DEFAULT_CONFIG = {
  prefix: '!',
  outputChannelId: '',
  leaderboardChannelId: '',
  leaderboardMessageId: '',
  githubToDiscord: {},
  discordToGithub: {},
  users: {}
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadConfig() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (error) {
    console.error('Failed to read config.json, using defaults:', error);
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(nextConfig) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(nextConfig, null, 2));
}

function hashColor(input) {
  const hash = crypto.createHash('md5').update(input).digest('hex');
  return parseInt(hash.substring(0, 6), 16);
}

function clampText(text, max) {
  if (!text) return 'N/A';
  if (text.length <= max) return text;
  return `${text.substring(0, max - 3)}...`;
}

function formatIsoDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function getXpToNext(level) {
  return Math.max(50, Math.floor(100 * Math.pow(level, 1.45)));
}

function addXp(user, amount) {
  const gained = Math.max(0, Math.round(amount));
  user.totalXp = (user.totalXp || 0) + gained;
  user.level = user.level || 1;
  user.xp = user.xp || 0;
  user.xp += gained;
  while (user.xp >= getXpToNext(user.level)) {
    user.xp -= getXpToNext(user.level);
    user.level += 1;
  }
  return gained;
}

function isAdmin(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}

function parseChannelId(arg) {
  if (!arg) return null;
  const match = arg.match(/^<#(\d+)>$/);
  if (match) return match[1];
  if (/^\d+$/.test(arg)) return arg;
  return null;
}

const config = loadConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(config.prefix)) return;

  const [rawCommand, ...args] = message.content.slice(config.prefix.length).trim().split(/\s+/);
  if (!rawCommand) return;
  const command = rawCommand.toLowerCase();

  if (command === 'ping') {
    await message.reply('pong');
    return;
  }

  if (command === 'help') {
    await message.reply(
      [
        'Commands:',
        `${config.prefix}setcommitschannel #channel (admin)`,
        `${config.prefix}setleaderboardchannel #channel (admin)`,
        `${config.prefix}setprefix <newPrefix> (admin)`,
        `${config.prefix}linkgithub <githubUsername>`,
        `${config.prefix}unlinkgithub`,
        `${config.prefix}leaderboard`,
        `${config.prefix}addxp @user <amount> (admin)`,
        `${config.prefix}debugconfig (admin)`
      ].join('\n')
    );
    return;
  }

  if (command === 'setcommitschannel') {
    if (!isAdmin(message.member)) {
      await message.reply('Admin permissions required.');
      return;
    }
    const channelId = parseChannelId(args[0]);
    if (!channelId) {
      await message.reply('Please mention a channel or provide a channel ID.');
      return;
    }
    config.outputChannelId = channelId;
    saveConfig(config);
    await message.reply(`Commit output channel set to <#${channelId}>.`);
    return;
  }

  if (command === 'setleaderboardchannel') {
    if (!isAdmin(message.member)) {
      await message.reply('Admin permissions required.');
      return;
    }
    const channelId = parseChannelId(args[0]);
    if (!channelId) {
      await message.reply('Please mention a channel or provide a channel ID.');
      return;
    }
    config.leaderboardChannelId = channelId;
    config.leaderboardMessageId = '';
    saveConfig(config);
    await message.reply(`Leaderboard channel set to <#${channelId}>.`);
    await updateLeaderboard(client, config);
    return;
  }

  if (command === 'setprefix') {
    if (!isAdmin(message.member)) {
      await message.reply('Admin permissions required.');
      return;
    }
    const nextPrefix = args[0];
    if (!nextPrefix) {
      await message.reply('Please provide a new prefix.');
      return;
    }
    config.prefix = nextPrefix;
    saveConfig(config);
    await message.reply(`Prefix updated to ${nextPrefix}.`);
    return;
  }

  if (command === 'linkgithub') {
    const githubUsername = args[0];
    if (!githubUsername) {
      await message.reply('Usage: linkgithub <githubUsername>');
      return;
    }
    const normalized = githubUsername.toLowerCase();
    config.discordToGithub[message.author.id] = githubUsername;
    config.githubToDiscord[normalized] = message.author.id;
    saveConfig(config);
    await message.reply(`Linked ${githubUsername} to your Discord user.`);
    return;
  }

  if (command === 'unlinkgithub') {
    const existing = config.discordToGithub[message.author.id];
    if (!existing) {
      await message.reply('No GitHub account linked.');
      return;
    }
    delete config.discordToGithub[message.author.id];
    delete config.githubToDiscord[existing.toLowerCase()];
    saveConfig(config);
    await message.reply(`Unlinked ${existing}.`);
    return;
  }

  if (command === 'leaderboard') {
    await updateLeaderboard(client, config);
    await message.reply('Leaderboard updated.');
    return;
  }

  if (command === 'addxp') {
    if (!isAdmin(message.member)) {
      await message.reply('Admin permissions required.');
      return;
    }
    const userId = args[0]?.replace(/[<@!>]/g, '');
    const amount = Number(args[1]);
    if (!userId || Number.isNaN(amount)) {
      await message.reply('Usage: addxp @user <amount>');
      return;
    }
    config.users[userId] = config.users[userId] || { level: 1, xp: 0, totalXp: 0 };
    const gained = addXp(config.users[userId], amount);
    saveConfig(config);
    await updateLeaderboard(client, config);
    await message.reply(`Added ${gained} XP to <@${userId}>.`);
    return;
  }

  if (command === 'debugconfig') {
    if (!isAdmin(message.member)) {
      await message.reply('Admin permissions required.');
      return;
    }
    const debugInfo = {
      prefix: config.prefix,
      outputChannelId: config.outputChannelId,
      leaderboardChannelId: config.leaderboardChannelId,
      linkedUsers: Object.keys(config.discordToGithub).length,
      trackedUsers: Object.keys(config.users).length
    };
    await message.reply(`Config: ${JSON.stringify(debugInfo)}`);
    return;
  }
});

async function updateLeaderboard(discordClient, currentConfig) {
  const channelId = currentConfig.leaderboardChannelId;
  if (!channelId) return;
  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const entries = Object.entries(currentConfig.users)
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      if (b.xp !== a.xp) return b.xp - a.xp;
      return b.totalXp - a.totalXp;
    })
    .slice(0, 10);

  const lines = entries.length
    ? entries.map((entry, index) => {
      const nextXp = getXpToNext(entry.level);
      return `${index + 1}. <@${entry.id}> - Level ${entry.level} (${entry.xp}/${nextXp} XP)`;
    })
    : ['No activity yet.'];

  const embed = new EmbedBuilder()
    .setTitle('Leaderboard')
    .setDescription(lines.join('\n'))
    .setColor(0x2b2d31)
    .setTimestamp(new Date());

  if (currentConfig.leaderboardMessageId) {
    const existing = await channel.messages.fetch(currentConfig.leaderboardMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed] });
      return;
    }
  }

  const message = await channel.send({ embeds: [embed] });
  currentConfig.leaderboardMessageId = message.id;
  saveConfig(currentConfig);
}

async function fetchCommitDetails(repo, sha) {
  if (!repo || !sha) return null;
  const headers = {
    'User-Agent': 'discord-github-leveling-bot',
    Accept: 'application/vnd.github+json'
  };
  if (process.env._GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env._GITHUB_TOKEN}`;
  }
  const response = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, { headers });
  if (!response.ok) {
    console.warn(`GitHub API error ${response.status} for ${repo}@${sha}`);
    return null;
  }
  return response.json();
}

async function processCommit(commit, payload, repo, branch) {
  const details = await fetchCommitDetails(repo, commit.id);
  const source = details || commit;
  const githubUser =
    details?.author?.login ||
    commit.author?.username ||
    commit.author?.name ||
    'unknown';
  const linkedDiscordId = config.githubToDiscord[githubUser.toLowerCase()];
  const authorDisplay = linkedDiscordId ? `<@${linkedDiscordId}> (${githubUser})` : githubUser;
  const commitMessage = details?.commit?.message || commit.message || '';
  const title = commitMessage.split('\n')[0] || 'Commit';
  const body = commitMessage.split('\n').slice(1).join('\n').trim();
  const commitDateValue = details?.commit?.author?.date || commit.timestamp;
  const commitDate = new Date(commitDateValue || Date.now());
  const safeCommitDate = Number.isNaN(commitDate.getTime()) ? new Date() : commitDate;

  const stats = details?.stats || null;
  const files = details?.files || null;
  const added = stats?.additions ?? null;
  const removed = stats?.deletions ?? null;
  const changedFiles = files ? files.length : null;

  const topFiles = files
    ? [...files]
        .sort((a, b) => b.changes - a.changes)
        .slice(0, 3)
        .map((file) => `${file.filename} (${file.changes})`)
    : [
        ...(commit.added || []),
        ...(commit.modified || []),
        ...(commit.removed || [])
      ].slice(0, 3).map((file) => `${file} (?)`);

  const extras = [];
  if (details?.parents?.length > 1) extras.push('Merge commit');
  if (body) extras.push('Has description');
  if (commit.distinct === false) extras.push('Non-distinct (possible rebase)');

  const embed = new EmbedBuilder()
    .setTitle(clampText(title, 256))
    .setURL(details?.html_url || commit.url)
    .setColor(hashColor(githubUser))
    .addFields(
      { name: 'Author', value: clampText(authorDisplay, 1024), inline: true },
      { name: 'Date', value: formatIsoDate(safeCommitDate), inline: true },
      { name: 'Branch', value: branch || 'unknown', inline: true },
      { name: 'Hash', value: commit.id?.substring(0, 8) || 'unknown', inline: true },
      { name: 'Lines Added', value: added !== null ? String(added) : 'N/A', inline: true },
      { name: 'Lines Removed', value: removed !== null ? String(removed) : 'N/A', inline: true },
      { name: 'Files Changed', value: changedFiles !== null ? String(changedFiles) : 'N/A', inline: true },
      { name: 'Top Files', value: clampText(topFiles.join('\n') || 'N/A', 1024) }
    )
    .setFooter({ text: payload.repository?.full_name || 'GitHub' })
    .setTimestamp(safeCommitDate);

  if (body) {
    embed.addFields({ name: 'Message', value: clampText(body, 1024) });
  }
  if (extras.length) {
    embed.addFields({ name: 'Commit Info', value: extras.join(', ') });
  }

  if (config.outputChannelId) {
    const channel = await client.channels.fetch(config.outputChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      await channel.send({ embeds: [embed] });
    }
  }

  if (linkedDiscordId && added !== null && removed !== null) {
    const xpGain = added + removed * 0.6;
    config.users[linkedDiscordId] = config.users[linkedDiscordId] || { level: 1, xp: 0, totalXp: 0 };
    addXp(config.users[linkedDiscordId], xpGain);
    saveConfig(config);
    await updateLeaderboard(client, config);
  }
}

function verifySignature(req) {
  const secret = process.env._GITHUB_WEBHOOK_SECRET;
  if (!secret) return true;
  const signature = req.get('x-hub-signature-256');
  if (!signature) return false;
  const digest = `sha256=${crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch (error) {
    return false;
  }
}

const app = express();
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

app.post('/github', async (req, res) => {
  if (!verifySignature(req)) {
    res.status(401).send('invalid signature');
    return;
  }

  if (req.get('x-github-event') !== 'push') {
    res.status(200).send('ignored');
    return;
  }

  res.status(202).send('ok');

  const payload = req.body;
  const repo = payload.repository?.full_name;
  const branch = payload.ref?.replace('refs/heads/', '') || 'unknown';

  for (const commit of payload.commits || []) {
    try {
      await processCommit(commit, payload, repo, branch);
    } catch (error) {
      console.error('Failed to process commit:', error);
    }
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Webhook server listening on ${port}`);
});

client.login(process.env.DISCORD_TOKEN);

