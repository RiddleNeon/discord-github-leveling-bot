const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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

const LEADERBOARD_REFRESH_ID = 'leaderboard:refresh';

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

function renderProgressBar(current, total, size = 16) {
  const safeTotal = Math.max(1, total || 0);
  const ratio = Math.min(1, Math.max(0, current / safeTotal));
  const filled = Math.round(ratio * size);
  return `[${'#'.repeat(filled)}${'-'.repeat(size - filled)}]`;
}

function buildLeaderboardComponents() {
  const refreshButton = new ButtonBuilder()
    .setCustomId(LEADERBOARD_REFRESH_ID)
    .setLabel('Refresh')
    .setStyle(ButtonStyle.Primary);

  const infoButton = new ButtonBuilder()
    .setCustomId('leaderboard:info')
    .setLabel('Top 10')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);

  return [new ActionRowBuilder().addComponents(refreshButton, infoButton)];
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

function isAdmin(memberOrPermissions) {
  const permissions = memberOrPermissions?.permissions ?? memberOrPermissions;
  return permissions?.has?.(PermissionsBitField.Flags.Administrator);
}

const slashCommands = [
  { name: 'ping', description: 'Check if the bot is alive' },
  { name: 'help', description: 'Show available commands' },
  {
    name: 'setcommitschannel',
    description: 'Set the commit output channel',
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    dm_permission: false,
    options: [
      {
        name: 'channel',
        description: 'Channel to post commits to',
        type: 7,
        required: true
      }
    ]
  },
  {
    name: 'setleaderboardchannel',
    description: 'Set the leaderboard channel',
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    dm_permission: false,
    options: [
      {
        name: 'channel',
        description: 'Channel to post the leaderboard in',
        type: 7,
        required: true
      }
    ]
  },
  {
    name: 'addxp',
    description: 'Add XP to a user',
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    dm_permission: false,
    options: [
      { name: 'user', description: 'User to add XP to', type: 6, required: true },
      { name: 'amount', description: 'Amount of XP', type: 4, required: true }
    ]
  },
  {
    name: 'debugconfig',
    description: 'Show the current config summary',
    default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
    dm_permission: false
  },
  {
    name: 'linkgithub',
    description: 'Link your Discord account to a GitHub username',
    dm_permission: false,
    options: [
      { name: 'username', description: 'GitHub username', type: 3, required: true }
    ]
  },
  { name: 'unlinkgithub', description: 'Remove your linked GitHub account', dm_permission: false },
  { name: 'leaderboard', description: 'Refresh the leaderboard embed', dm_permission: false }
];

async function registerCommands() {
  if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
    console.warn('DISCORD_TOKEN or CLIENT_ID missing; skipping slash command registration.');
    return;
  }
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    if (process.env.GUILD_ID) {
      // Remove global commands to avoid duplicates when using guild-scoped commands.
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), {
        body: slashCommands
      });
      console.log('Registered guild slash commands.');
    } else {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: slashCommands });
      console.log('Registered global slash commands.');
    }
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
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
  registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId === LEADERBOARD_REFRESH_ID) {
      await interaction.deferReply({ ephemeral: true });
      await updateLeaderboard(client, config);
      await interaction.editReply('Leaderboard updated.');
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply({ content: 'pong', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('Command Guide')
      .setDescription(
        [
          '`/setcommitschannel #channel` (admin)',
          '`/setleaderboardchannel #channel` (admin)',
          '`/addxp @user <amount>` (admin)',
          '`/debugconfig` (admin)',
          '`/linkgithub <githubUsername>`',
          '`/unlinkgithub`',
          '`/leaderboard`'
        ].join('\n')
      )
      .setColor(0x5865f2);

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (interaction.commandName === 'setcommitschannel') {
    if (!isAdmin(interaction.memberPermissions)) {
      await interaction.reply({ content: 'Admin permissions required.', ephemeral: true });
      return;
    }
    const channel = interaction.options.getChannel('channel', true);
    if (!channel.isTextBased()) {
      await interaction.reply({ content: 'Please choose a text channel.', ephemeral: true });
      return;
    }
    config.outputChannelId = channel.id;
    saveConfig(config);
    await interaction.reply({ content: `Commit output channel set to <#${channel.id}>.`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'setleaderboardchannel') {
    if (!isAdmin(interaction.memberPermissions)) {
      await interaction.reply({ content: 'Admin permissions required.', ephemeral: true });
      return;
    }
    const channel = interaction.options.getChannel('channel', true);
    if (!channel.isTextBased()) {
      await interaction.reply({ content: 'Please choose a text channel.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    config.leaderboardChannelId = channel.id;
    config.leaderboardMessageId = '';
    saveConfig(config);
    await updateLeaderboard(client, config);
    await interaction.editReply(`Leaderboard channel set to <#${channel.id}>.`);
    return;
  }

  if (interaction.commandName === 'linkgithub') {
    const githubUsername = interaction.options.getString('username', true);
    const normalized = githubUsername.toLowerCase();
    config.discordToGithub[interaction.user.id] = githubUsername;
    config.githubToDiscord[normalized] = interaction.user.id;
    saveConfig(config);
    await interaction.reply({ content: `Linked ${githubUsername} to your Discord user.`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'unlinkgithub') {
    const existing = config.discordToGithub[interaction.user.id];
    if (!existing) {
      await interaction.reply({ content: 'No GitHub account linked.', ephemeral: true });
      return;
    }
    delete config.discordToGithub[interaction.user.id];
    delete config.githubToDiscord[existing.toLowerCase()];
    saveConfig(config);
    await interaction.reply({ content: `Unlinked ${existing}.`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'leaderboard') {
    await interaction.deferReply({ ephemeral: true });
    await updateLeaderboard(client, config);
    await interaction.editReply('Leaderboard updated.');
    return;
  }

  if (interaction.commandName === 'addxp') {
    if (!isAdmin(interaction.memberPermissions)) {
      await interaction.reply({ content: 'Admin permissions required.', ephemeral: true });
      return;
    }
    const targetUser = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);
    config.users[targetUser.id] = config.users[targetUser.id] || { level: 1, xp: 0, totalXp: 0 };
    const gained = addXp(config.users[targetUser.id], amount);
    saveConfig(config);
    await updateLeaderboard(client, config);
    await interaction.reply({ content: `Added ${gained} XP to <@${targetUser.id}>.`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'debugconfig') {
    if (!isAdmin(interaction.memberPermissions)) {
      await interaction.reply({ content: 'Admin permissions required.', ephemeral: true });
      return;
    }
    const debugInfo = {
      outputChannelId: config.outputChannelId,
      leaderboardChannelId: config.leaderboardChannelId,
      linkedUsers: Object.keys(config.discordToGithub).length,
      trackedUsers: Object.keys(config.users).length
    };
    const embed = new EmbedBuilder()
      .setTitle('Config Snapshot')
      .setColor(0x2b2d31)
      .setDescription(`\`\`\`json\n${JSON.stringify(debugInfo, null, 2)}\n\`\`\``);
    await interaction.reply({ embeds: [embed], ephemeral: true });
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

  const resolvedEntries = await Promise.all(
    entries.map(async (entry) => {
      const displayName = await resolveDisplayName(discordClient, channel, entry.id);
      const nextXp = getXpToNext(entry.level);
      const bar = renderProgressBar(entry.xp, nextXp, 18);
      const percent = Math.round((entry.xp / Math.max(1, nextXp)) * 100);
      return { ...entry, displayName, nextXp, bar, percent };
    })
  );

  const embed = new EmbedBuilder()
    .setTitle('Leaderboard')
    .setColor(resolvedEntries[0] ? hashColor(resolvedEntries[0].id) : 0x2b2d31)
    .setTimestamp(new Date());

  if (!resolvedEntries.length) {
    embed.setDescription('No activity yet.');
  } else {
    embed.setDescription('Top 10 contributors, ranked by level and XP.');
    embed.addFields(
      resolvedEntries.map((entry, index) => {
        const rankLabel = String(index + 1).padStart(2, '0');
        const levelLabel = String(entry.level).padStart(2, '0');
        const safeName = clampText(entry.displayName, 32);
        return {
          name: `${rankLabel} | @${safeName}`,
          value: `Level ${levelLabel} • ${entry.xp}/${entry.nextXp} XP • ${entry.percent}%\n${entry.bar}`,
          inline: false
        };
      })
    );
  }

  const components = buildLeaderboardComponents();

  if (currentConfig.leaderboardMessageId) {
    const existing = await channel.messages.fetch(currentConfig.leaderboardMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed], components });
      return;
    }
  }

  const message = await channel.send({ embeds: [embed], components });
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

  const summaryLines = [
    `Author: ${authorDisplay}`,
    `Branch: ${branch || 'unknown'}`,
    `Hash: ${commit.id?.substring(0, 8) || 'unknown'}`,
    `Date: ${formatIsoDate(safeCommitDate)}`
  ].join('\n');

  const changeLines = [
    `Lines Added: ${added !== null ? String(added) : 'N/A'}`,
    `Lines Removed: ${removed !== null ? String(removed) : 'N/A'}`,
    `Files Changed: ${changedFiles !== null ? String(changedFiles) : 'N/A'}`
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle(clampText(title, 256))
    .setURL(details?.html_url || commit.url)
    .setColor(hashColor(githubUser))
    .setDescription(body ? clampText(body, 1024) : null)
    .addFields(
      { name: 'Summary', value: clampText(summaryLines, 1024).split('\n').map((line) => `- ${line}`).join('\n'), inline: true },
      { name: 'Changes', value: clampText(changeLines, 1024).split('\n').map((line) => `- ${line}`).join('\n'), inline: true },
      { name: 'Top Files', value: clampText(topFiles.join('\n') || 'N/A', 1024).split('\n').map((line) => `- ${line}`).join('\n') }
    )
    .setFooter({ text: payload.repository?.full_name || 'GitHub' })
    .setTimestamp(safeCommitDate);

  if (extras.length) {
    embed.addFields({ name: 'Notes', value: extras.join(' | ') });
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
