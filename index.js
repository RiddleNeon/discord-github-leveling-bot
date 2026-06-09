const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    PermissionsBitField,
    REST,
    Routes,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags
} = require('discord.js');

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

const LEVEL_ROLE_PREFIX = '⌈ Lv. ⌋ ';
const TOP_ROLE_NAME = '✦ 𝓐𝖑𝖕𝖍𝖆 𝓒𝖔𝖒𝖒𝖎𝖙𝖙𝖊𝖗 ✦';

const MESSAGE_XP_SETTINGS = {
    baseXp: 5,
    maxHourlyXp: 80,
    fastIntervalMs: 10 * 1000,
    mediumIntervalMs: 30 * 1000,
    slowIntervalMs: 60 * 1000,
    cooldownIntervalMs: 2 * 1000,
    bonusIntervalMs: 30 * 60 * 1000
};

const LEADERBOARD_THROTTLE_MS = 30 * 1000;
let lastLeaderboardUpdateAt = 0;

const RANGE_ROLES = [
    {name: '⟡ Bronze Coder ⟡', min: 1, max: 4, color: 0xcd7f32},

    {name: '✧ Silver Engineer ✧', min: 5, max: 9, color: 0xc0c0c0},

    {name: '✦ Gold Architect ✦', min: 10, max: 19, color: 0xffd700},

    {name: '❖ Platinum Refactorer ❖', min: 20, max: 34, color: 0x6ad4dd},

    {name: '⬥ Diamond Overclocker ⬥', min: 35, max: 49, color: 0x6fa8ff},

    {name: '☬ Mythic Committer ☬', min: 50, max: 9999, color: 0xb26bff}
];

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, {recursive: true});
    }
}

function loadConfig() {
    ensureDataDir();
    if (!fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
        return {...DEFAULT_CONFIG};
    }
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        return {...DEFAULT_CONFIG, ...JSON.parse(raw)};
    } catch (error) {
        console.error('Failed to read config.json, using defaults:', error);
        return {...DEFAULT_CONFIG};
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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatIsoDate(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return new Date().toISOString();
    return date.toISOString();
}

function renderProgressBar(currentLevel, currentXp, total, size = 16) {
    const safeTotal = Math.max(1, total || 0);
    const ratio = Math.min(1, Math.max(0, currentXp / safeTotal));

    const filled = Math.round(ratio * size);

    return 'Level ' + currentLevel + '  ' + `▰`.repeat(filled) + `▱`.repeat(size - filled) + '  Level ' + (currentLevel + 1);
}

function hslToRgbInt(h, s, l) {
    const hue = ((h % 360) + 360) % 360;
    const sat = Math.min(100, Math.max(0, s)) / 100;
    const light = Math.min(100, Math.max(0, l)) / 100;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = light - c / 2;
    let r = 0;
    let g = 0;
    let b = 0;

    if (hue < 60) {
        r = c;
        g = x;
        b = 0;
    } else if (hue < 120) {
        r = x;
        g = c;
        b = 0;
    } else if (hue < 180) {
        r = 0;
        g = c;
        b = x;
    } else if (hue < 240) {
        r = 0;
        g = x;
        b = c;
    } else if (hue < 300) {
        r = x;
        g = 0;
        b = c;
    } else {
        r = c;
        g = 0;
        b = x;
    }

    const toByte = (value) => Math.round((value + m) * 255);
    return (toByte(r) << 16) + (toByte(g) << 8) + toByte(b);
}

function getLevelRoleColor(level) {
    const normalized = Math.min(100, Math.max(1, Math.round(level || 1)));
    const hue = 210 - normalized * 1.7; // higher level => warmer hue
    return hslToRgbInt(hue, 70, 45);
}

function getRangeRole(level) {
    return RANGE_ROLES.find((range) => level >= range.min && level <= range.max) || RANGE_ROLES[0];
}

function isLevelRole(role) {
    return role?.name?.startsWith(LEVEL_ROLE_PREFIX);
}

function isRangeRole(role) {
    return RANGE_ROLES.some((range) => range.name === role?.name);
}

function isTextChannel(channel) {
    if (!channel) return false;
    if (typeof channel.isTextBased === 'function' && typeof channel.isDMBased === 'function') {
        return channel.isTextBased() && !channel.isDMBased();
    }
    return [
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread
    ].includes(channel.type);
}

function buildLeaderboardComponents() {
    const refreshButton = new ButtonBuilder()
        .setCustomId(LEADERBOARD_REFRESH_ID)
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Primary);

    return [new ActionRowBuilder().addComponents(refreshButton)];
}

async function ensureRole(guild, name, color, hoist = false) {
    if (!guild) return null;
    const existing = guild.roles.cache.find((role) => role.name === name);
    if (existing) {
        if (typeof color === 'number' && existing.color !== color) {
            await existing.setColor(color).catch(() => null);
        }
        if (typeof hoist === 'boolean' && existing.hoist !== hoist) {
            await existing.setHoist(hoist).catch(() => null);
        }
        return existing;
    }

    const created = await guild.roles.create({
        name,
        color: typeof color === 'number' ? color : undefined,
        hoist,
        mentionable: false
    })
        .catch(() => null);

    if (!created) return null;

    const botMember = guild.members.me || await guild.members.fetch(guild.client.user.id).catch(() => null);
    const highestPosition = botMember?.roles?.highest?.position;
    if (typeof highestPosition === 'number' && highestPosition > 1) {
        const isTopRole = name === TOP_ROLE_NAME;
        const desired = Math.max(1, highestPosition - (isTopRole ? 1 : 2));
        if (created.position < desired) {
            await created.setPosition(desired).catch(() => null);
        }
    }

    return created;
}

async function cleanupStaleRoles(guild, activeUserIds, topUserId) {
    if (!guild) return;
    const topRole = guild.roles.cache.find((role) => role.name === TOP_ROLE_NAME) || null;
    const relevantRoles = guild.roles.cache.filter((role) => isLevelRole(role) || isRangeRole(role) || role.id === topRole?.id);

    for (const role of relevantRoles.values()) {
        for (const [memberId, member] of role.members) {
            if (role.id === topRole?.id && memberId === topUserId) continue;
            if (!activeUserIds.has(memberId)) {
                await member.roles.remove(role.id).catch(() => null);
            }
        }
    }
}

async function ensureLevelRole(guild, level) {
    const name = `${LEVEL_ROLE_PREFIX}${level}`;
    const role = await ensureRole(guild, name, getLevelRoleColor(level), false);
    return role;
}

async function ensureRangeRole(guild, level) {
    const range = getRangeRole(level);
    return ensureRole(guild, range.name, range.color, false);
}

async function ensureTopRole(guild) {
    return ensureRole(guild, TOP_ROLE_NAME, 0xff4f81, true);
}

async function applyRolePositions(topRole, levelRole, rangeRole) {
    if (!topRole) return;
    const targetAbove = [levelRole, rangeRole].filter(Boolean).map((role) => role.position);
    if (!targetAbove.length) return;
    const desired = Math.max(...targetAbove) + 1;
    if (topRole.position < desired) {
        await topRole.setPosition(desired).catch(() => null);
    }
}

async function assignRolesForGuild(guild, currentConfig) {
    if (!guild || !currentConfig?.users) return;

    const entries = Object.entries(currentConfig.users)
        .map(([id, data]) => ({id, totalXp: Math.round(data?.totalXp || 0)}))
        .filter((entry) => entry.totalXp > 0);

    const activeUserIds = new Set(entries.map((entry) => entry.id));

    if (!entries.length) {
        await cleanupStaleRoles(guild, activeUserIds, null);
        return;
    }

    const topEntry = [...entries].sort((a, b) => b.totalXp - a.totalXp)[0];
    const topUserId = topEntry?.id;
    const topRole = await ensureTopRole(guild);
    await cleanupStaleRoles(guild, activeUserIds, topUserId);

    for (const entry of entries) {
        const member = await guild.members.fetch(entry.id).catch(() => null);
        if (!member) continue;

        const progress = getLevelFromTotalXp(entry.totalXp);
        const levelRole = await ensureLevelRole(guild, progress.level);
        const rangeRole = await ensureRangeRole(guild, progress.level);
        await applyRolePositions(topRole, levelRole, rangeRole);

        const desiredRoleIds = new Set([
            levelRole?.id,
            rangeRole?.id,
            entry.id === topUserId ? topRole?.id : null
        ].filter(Boolean));

        const rolesToRemove = member.roles.cache.filter((role) => {
            if (role.id === topRole?.id) return entry.id !== topUserId;
            if (isLevelRole(role)) return role.id !== levelRole?.id;
            if (isRangeRole(role)) return role.id !== rangeRole?.id;
            return false;
        });

        if (rolesToRemove.size) {
            await member.roles.remove([...rolesToRemove.keys()]).catch(() => null);
        }

        const rolesToAdd = [...desiredRoleIds].filter((roleId) => !member.roles.cache.has(roleId));
        if (rolesToAdd.length) {
            await member.roles.add(rolesToAdd).catch(() => null);
        }
    }
}

async function resolveDisplayName(discordClient, channel, userId) {
    const guild = channel?.guild;
    if (guild) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member?.displayName) return member.displayName;
    }

    const user = await discordClient.users.fetch(userId).catch(() => null);
    return user?.username || `User ${userId}`;
}

function getXpToNext(level) {
    return Math.max(50, Math.floor(100 * Math.pow(level, 1.45)));
}

function getMessageXpWeight(deltaMs) {
    if (deltaMs <= MESSAGE_XP_SETTINGS.fastIntervalMs) return 0.15;
    if (deltaMs <= MESSAGE_XP_SETTINGS.mediumIntervalMs) return 0.35;
    if (deltaMs <= MESSAGE_XP_SETTINGS.slowIntervalMs) return 0.6;
    if (deltaMs <= MESSAGE_XP_SETTINGS.cooldownIntervalMs) return 0.85;
    if (deltaMs <= MESSAGE_XP_SETTINGS.bonusIntervalMs) return 1.0;
    return 1.15;
}

function ensureMessageXpState(user) {
    user.messageXp = user.messageXp || {
        hourStart: 0,
        hourlyXp: 0,
        lastMessageAt: 0
    };
    return user.messageXp;
}

function awardMessageXp(user, nowMs) {
    const state = ensureMessageXpState(user);
    if (!state.hourStart || nowMs - state.hourStart >= 60 * 60 * 1000) {
        state.hourStart = nowMs;
        state.hourlyXp = 0;
    }

    const deltaMs = state.lastMessageAt ? nowMs - state.lastMessageAt : null;
    const weight = deltaMs === null ? 1 : getMessageXpWeight(deltaMs);
    let gained = Math.max(0, Math.round(MESSAGE_XP_SETTINGS.baseXp * weight));

    const remaining = MESSAGE_XP_SETTINGS.maxHourlyXp - state.hourlyXp;
    if (remaining <= 0 || gained <= 0) {
        state.lastMessageAt = nowMs;
        return 0;
    }

    if (gained > remaining) gained = remaining;

    state.hourlyXp += gained;
    state.lastMessageAt = nowMs;
    addXp(user, gained);
    return gained;
}

async function maybeUpdateLeaderboard(discordClient, currentConfig) {
    const now = Date.now();
    if (now - lastLeaderboardUpdateAt < LEADERBOARD_THROTTLE_MS) return;
    lastLeaderboardUpdateAt = now;
    await updateLeaderboard(discordClient, currentConfig);
}

function addXp(user, amount) {
    const gained = Math.round(Number(amount) || 0);
    user.totalXp = Math.round((user.totalXp || 0) + gained);
    return gained;
}

function ensureUserRecord(users, userId) {
    users[userId] = users[userId] || {totalXp: 0};
    ensureMessageXpState(users[userId]);
    return users[userId];
}

function calculateTotalXpFromLevel(level, xp = 0) {
    let total = 0;
    for (let current = 1; current < level; current += 1) {
        total += getXpToNext(current);
    }
    return total + Math.max(0, Math.round(xp));
}

function getLevelFromTotalXp(totalXp) {
    const normalizedTotal = Math.max(0, Math.round(totalXp || 0));
    let remaining = normalizedTotal;
    let level = 1;
    while (remaining >= getXpToNext(level)) {
        remaining -= getXpToNext(level);
        level += 1;
    }
    return {
        level,
        xp: remaining,
        totalXp: Math.round(totalXp || 0),
        nextXp: getXpToNext(level)
    };
}

function setUserLevel(user, level, xp = 0) {
    const safeLevel = Math.max(1, Math.round(level));
    const maxXp = getXpToNext(safeLevel);
    const safeXp = Math.min(Math.max(0, Math.round(xp)), Math.max(0, maxXp - 1));
    user.totalXp = calculateTotalXpFromLevel(safeLevel, safeXp);
    return getLevelFromTotalXp(user.totalXp);
}

function setUserTotalXp(user, total) {
    user.totalXp = Math.round(total || 0);
    return getLevelFromTotalXp(user.totalXp);
}

function isAdmin(memberOrPermissions) {
    const permissions = memberOrPermissions?.permissions ?? memberOrPermissions;
    return permissions?.has?.(PermissionsBitField.Flags.Administrator);
}

async function safeEditReply(interaction, payload) {
    if (!interaction.isRepliable?.()) return;
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => null);
        return;
    }
    await interaction.reply({...payload, flags: MessageFlags.Ephemeral}).catch(() => null);
}

const slashCommands = [
    {name: 'ping', description: 'Check if the bot is alive'},
    {name: 'help', description: 'Show available commands'},
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
            {name: 'user', description: 'User to add XP to', type: 6, required: true},
            {name: 'amount', description: 'Amount of XP', type: 4, required: true}
        ]
    },
    {
        name: 'removexp',
        description: 'Remove XP from a user',
        default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
        dm_permission: false,
        options: [
            {name: 'user', description: 'User to remove XP from', type: 6, required: true},
            {name: 'amount', description: 'Amount of XP', type: 4, required: true}
        ]
    },
    {
        name: 'setxp',
        description: 'Set current XP within the user\'s level',
        default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
        dm_permission: false,
        options: [
            {name: 'user', description: 'User to update', type: 6, required: true},
            {name: 'xp', description: 'XP for the current level', type: 4, required: true}
        ]
    },
    {
        name: 'setlevel',
        description: 'Set a user\'s level (optionally set XP)',
        default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
        dm_permission: false,
        options: [
            {name: 'user', description: 'User to update', type: 6, required: true},
            {name: 'level', description: 'Target level', type: 4, required: true},
            {name: 'xp', description: 'Optional XP for the level', type: 4, required: false}
        ]
    },
    {
        name: 'settotalxp',
        description: 'Set a user\'s total XP (auto recalculates level)',
        default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
        dm_permission: false,
        options: [
            {name: 'user', description: 'User to update', type: 6, required: true},
            {name: 'total', description: 'Total XP', type: 4, required: true}
        ]
    },
    {
        name: 'resetuser',
        description: 'Reset a user\'s XP and level',
        default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
        dm_permission: false,
        options: [
            {name: 'user', description: 'User to reset', type: 6, required: true}
        ]
    },
    {
        name: 'resetall',
        description: 'Reset all users (requires confirm)',
        default_member_permissions: PermissionsBitField.Flags.Administrator.toString(),
        dm_permission: false,
        options: [
            {name: 'confirm', description: 'Set to true to confirm', type: 5, required: true}
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
            {name: 'username', description: 'GitHub username', type: 3, required: true}
        ]
    },
    {name: 'unlinkgithub', description: 'Remove your linked GitHub account', dm_permission: false},
    {name: 'leaderboard', description: 'Refresh the leaderboard embed', dm_permission: false}
];

async function registerCommands() {
    if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
        console.warn('DISCORD_TOKEN or CLIENT_ID missing; skipping slash command registration.');
        return;
    }
    const rest = new REST({version: '10'}).setToken(process.env.DISCORD_TOKEN);
    const commandScope = (process.env.COMMAND_SCOPE || (process.env.GUILD_ID ? 'guild' : 'global')).toLowerCase();
    try {
        if (commandScope === 'guild') {
            // Remove global commands to avoid duplicates when using guild-scoped commands.
            await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {body: []});
            if (!process.env.GUILD_ID) {
                console.warn('COMMAND_SCOPE=guild but GUILD_ID is missing; skipping registration.');
                return;
            }
            await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), {
                body: slashCommands
            });
            console.log('Registered guild slash commands.');
            return;
        }

        if (process.env.GUILD_ID) {
            // Remove guild commands to avoid duplicates when using global commands.
            await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), {body: []});
        }
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {body: slashCommands});
        console.log('Registered global slash commands.');
    } catch (error) {
        console.error('Failed to register slash commands:', error);
    }
}

const config = loadConfig();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    registerCommands();
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const record = ensureUserRecord(config.users, message.author.id);
    const gained = awardMessageXp(record, Date.now());
    if (gained > 0) {
        saveConfig(config);
        await maybeUpdateLeaderboard(client, config);
    }

    if (message.content.startsWith("meow")) {
        await message.reply('Meow motherfucker');
    }

    if (/6.{0,5}7/s.test(message.content)) {
        await message.react('6️⃣');
        await message.react('7️⃣');
    }

});

client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isButton()) {
            if (interaction.customId === LEADERBOARD_REFRESH_ID) {
                try {
                    await interaction.deferReply({
                        flags: MessageFlags.Ephemeral
                    });

                    await updateLeaderboard(client, config);

                    await interaction.editReply('Leaderboard updated.');
                } catch (err) {
                    console.error(err);

                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({
                            content: 'Failed to refresh leaderboard.',
                            flags: MessageFlags.Ephemeral
                        }).catch(() => {
                        });
                    }
                }
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === 'ping') {
            await interaction.reply({content: 'pong', flags: MessageFlags.Ephemeral});
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
                        '`/removexp @user <amount>` (admin)',
                        '`/setxp @user <xp>` (admin)',
                        '`/setlevel @user <level> [xp]` (admin)',
                        '`/settotalxp @user <total>` (admin)',
                        '`/resetuser @user` (admin)',
                        '`/resetall confirm:true` (admin)',
                        '`/debugconfig` (admin)',
                        '`/linkgithub <githubUsername>`',
                        '`/unlinkgithub`',
                        '`/leaderboard`'
                    ].join('\n')
                )
                .setColor(0x5865f2);

            await interaction.reply({embeds: [embed], flags: MessageFlags.Ephemeral});
            return;
        }

        if (interaction.commandName === 'setcommitschannel') {
            if (!isAdmin(interaction.memberPermissions)) {
                await interaction.reply({content: 'Admin permissions required.', flags: MessageFlags.Ephemeral});
                return;
            }
            await interaction.deferReply({flags: MessageFlags.Ephemeral});
            const channel = interaction.options.getChannel('channel', true);
            if (!isTextChannel(channel)) {
                await interaction.editReply({content: 'Please choose a text channel.'});
                return;
            }
            config.outputChannelId = channel.id;
            saveConfig(config);
            await interaction.editReply({content: `Commit output channel set to <#${channel.id}>.`});
            return;
        }

        if (interaction.commandName === 'setleaderboardchannel') {
            if (!isAdmin(interaction.memberPermissions)) {
                await interaction.reply({content: 'Admin permissions required.', flags: MessageFlags.Ephemeral});
                return;
            }
            await interaction.deferReply({flags: MessageFlags.Ephemeral});
            const channel = interaction.options.getChannel('channel', true);
            if (!isTextChannel(channel)) {


                await interaction.editReply({content: 'Please choose a text channel.'});
                return;
            }
            config.leaderboardChannelId = channel.id;
            config.leaderboardMessageId = '';
            saveConfig(config);
            await updateLeaderboard(client, config);
            await interaction.editReply(`Leaderboard channel set to <#${channel.id}>.`);
            return;
        }

        if (interaction.commandName === 'addxp') {
            if (!isAdmin(interaction.memberPermissions)) {
                await interaction.reply({content: 'Admin permissions required.', flags: MessageFlags.Ephemeral});
                return;
            }
            await interaction.deferReply({flags: MessageFlags.Ephemeral});
            const targetUser = interaction.options.getUser('user', true);
            const amount = interaction.options.getInteger('amount', true);
            const record = ensureUserRecord(config.users, targetUser.id);
            const gained = addXp(record, amount);
            saveConfig(config);
            await updateLeaderboard(client, config);
            await interaction.editReply({content: `Added ${gained} XP to <@${targetUser.id}>.`});
            return;
        }

        if (interaction.commandName === 'removexp') {
            if (!isAdmin(interaction.memberPermissions)) {
                await interaction.reply({content: 'Admin permissions required.', flags: MessageFlags.Ephemeral});
                return;
            }
            await interaction.deferReply({flags: MessageFlags.Ephemeral});
            const targetUser = interaction.options.getUser('user', true);
            const amount = Math.abs(interaction.options.getInteger('amount', true));
            const record = ensureUserRecord(config.users, targetUser.id);
            const next = setUserTotalXp(record, (record.totalXp || 0) - amount);
            saveConfig(config);
            await updateLeaderboard(client, config);
            await interaction.editReply({
                content: `Removed ${amount} XP from <@${targetUser.id}>. Now level ${next.level} with ${next.xp}/${next.nextXp} XP.`,
            });
            return;
        }

        if (interaction.commandName === 'setxp') {
            if (!isAdmin(interaction.memberPermissions)) {
                await interaction.reply({content: 'Admin permissions required.', flags: MessageFlags.Ephemeral});
                return;
            }
            await interaction.deferReply({flags: MessageFlags.Ephemeral});
            const targetUser = interaction.options.getUser('user', true);
            const xp = interaction.options.getInteger('xp', true);
            const record = ensureUserRecord(config.users, targetUser.id);
            const current = getLevelFromTotalXp(record.totalXp || 0);
            const next = setUserLevel(record, current.level, xp);
            saveConfig(config);
            await updateLeaderboard(client, config);
            await interaction.editReply({
                content: `Set <@${targetUser.id}> to level ${next.level} with ${next.xp}/${next.nextXp} XP.`,
            });
            return;
        }
        
        

        if (interaction.commandName === 'setlevel') {
            if (!isAdmin(interaction.memberPermissions)) {
                await interaction.reply({content: 'Admin permissions required.', flags: MessageFlags.Ephemeral});
                return;
            }
            await interaction.deferReply({flags: MessageFlags.Ephemeral});
            const targetUser = interaction.options.getUser('user', true);
            const level = interaction.options.getInteger('level', true);
            const xp = interaction.options.getInteger('xp');
            const record = ensureUserRecord(config.users, targetUser.id);
            const next = setUserLevel(record, level, xp ?? 0);
            saveConfig(config);
            await updateLeaderboard(client, config);
            await interaction.editReply({
                content: `Set <@${targetUser.id}> to level ${next.level} with ${next.xp}/${next.nextXp} XP.`,
            });
            return;
        }

        if (interaction.commandName === 'settotalxp') {
            if (!isAdmin(interaction.memberPermissions)) {
                await interaction.reply({content: 'Admin permissions required.', flags: MessageFlags.Ephemeral});
                return;
            }
            await interaction.deferReply({flags: MessageFlags.Ephemeral});
            const targetUser = interaction.options.getUser('user', true);
            const total = interaction.options.getInteger('total', true);
            const record = ensureUserRecord(config.users, targetUser.id);
            const next = setUserTotalXp(record, total);
            saveConfig(config);
            await updateLeaderboard(client, config);
            await interaction.editReply({
                content: `Set <@${targetUser.id}> to total ${next.totalXp} XP (level ${next.level}, ${next.xp}/${next.nextXp}).`,
            });
            return;
        }

        if (interaction.commandName === 'resetuser') {
            if (!isAdmin(interaction.memberPermissions)) {
                await interaction.reply({content: 'Admin permissions required.', flags: MessageFlags.Ephemeral});
                return;
            }
            await interaction.deferReply({flags: MessageFlags.Ephemeral});
            const targetUser = interaction.options.getUser('user', true);
            delete config.users[targetUser.id];
            saveConfig(config);
            await updateLeaderboard(client, config);
            await interaction.editReply({content: `Reset stats for <@${targetUser.id}>.`});
            return;
        }

        if (interaction.commandName === 'resetall') {
            if (!isAdmin(interaction.memberPermissions)) {
                await interaction.reply({content: 'Admin permissions required.', flags: MessageFlags.Ephemeral});
                return;
            }
            await interaction.deferReply({flags: MessageFlags.Ephemeral});
            const confirm = interaction.options.getBoolean('confirm', true);
            if (!confirm) {
                await interaction.editReply({content: 'Reset canceled. Set confirm:true to proceed.'});
                return;
            }
            config.users = {};
            saveConfig(config);
            await updateLeaderboard(client, config);
            await interaction.editReply({content: 'All user stats have been reset.'});
            return;
        }

        if (interaction.commandName === 'debugconfig') {
            if (!isAdmin(interaction.memberPermissions)) {
                await interaction.reply({content: 'Admin permissions required.', flags: MessageFlags.Ephemeral});
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
            await interaction.reply({embeds: [embed], flags: MessageFlags.Ephemeral});
        }
    } catch (error) {
        console.error('Interaction failed:', error);
        await safeEditReply(interaction, {content: 'Something went wrong while processing that command.'});
    }
});

function formatValue(value) {
    if (typeof value !== 'number' || !isFinite(value)) return String(value);

    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';

    const format = (num, suffix) => {
        const v = Math.round(num * 10) / 10;
        const s = v % 1 === 0 ? String(v | 0) : String(v);
        return `${sign}${s}${suffix}`;
    };

    if (abs >= 1e9) return format(abs / 1e9, 'b');
    if (abs >= 1e6) return format(abs / 1e6, 'm');
    if (abs >= 1e3) return format(abs / 1e3, 'k');
    return String(value);
}

async function updateLeaderboard(discordClient, currentConfig) {
    const channelId = currentConfig.leaderboardChannelId;
    if (!channelId) return;
    const channel = await discordClient.channels.fetch(channelId).catch(() => null);
    if (!channel || !isTextChannel(channel)) return;

    const entries = Object.entries(currentConfig.users)
        .map(([id, data]) => ({id, ...data}))
        .sort((a, b) => (b.totalXp || 0) - (a.totalXp || 0))
        .slice(0, 10);

    const resolvedEntries = await Promise.all(
        entries.map(async (entry) => {
            const displayName = await resolveDisplayName(discordClient, channel, entry.id);
            const progress = getLevelFromTotalXp(entry.totalXp || 0);
            const bar = renderProgressBar(progress.level, progress.xp, progress.nextXp, 18);
            const percent = Math.round((progress.xp / Math.max(1, progress.nextXp)) * 100);
            const totalXpFormatted = formatValue(entry.totalXp);
            return {...entry, displayName, ...progress, bar, percent, totalXpFormatted};
        })
    );

    const embed = new EmbedBuilder()
        .setTitle('🏆 Server Leaderboard')
        .setDescription('\nTop contributors ranked by XP\n\n')
        .setColor(0xf1c40f)
        .setThumbnail(discordClient.user.displayAvatarURL())
        .setFooter({
            text: 'Level System'
        })
        .setTimestamp();

    if (!resolvedEntries.length) {
        embed.setDescription('No activity yet.');
    } else {
        embed.setDescription('Top 10 contributors, ranked by level and XP.');
        const medals = ['🥇', '🥈', '🥉'];

        embed.addFields(
            resolvedEntries.map((entry, index) => {
                const safeName = clampText(entry.displayName, 24);

                const rank =
                    medals[index] ||
                    `#${index + 1}`;
                
                let content = [
                    `  **${rank}  ${safeName}**`,
                    '',
                    `⭐ Level ${entry.level} (${entry.totalXpFormatted} xp)`,
                    '',
                    `${entry.bar}`,
                    `> ${entry.xp} / ${entry.nextXp} XP  •  ${entry.percent}%`,
                    '',
                    '─────────────────────────────────────────────',
                    '',
                    ''
                ].join('\n');

                let value;
                if (index === 0) {
                    value =
                        [
                            '─────────────────────────────────────────────',
                            '  👑 **CURRENT LEADER** 👑 ',
                            content
                        ].join('\n')
                } else {
                    value =
                        [
                            '─────────────────────────────────────────────',
                            content
                        ].join('\n');
                }


                return {
                    name: '\u200B',
                    value: value,
                    inline: false
                };
            })
        );
    }

    const components = buildLeaderboardComponents();

    if (currentConfig.leaderboardMessageId) {
        const existing = await channel.messages.fetch(currentConfig.leaderboardMessageId).catch(() => null);
        if (existing) {
            await existing.edit({embeds: [embed], components});
            await assignRolesForGuild(channel.guild, currentConfig);
            return;
        }
    }

    const message = await channel.send({embeds: [embed], components});
    currentConfig.leaderboardMessageId = message.id;
    saveConfig(currentConfig);
    await assignRolesForGuild(channel.guild, currentConfig);
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

    const url = `https://api.github.com/repos/${repo}/commits/${sha}`;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const response = await fetch(url, {headers});
        if (response.ok) {
            return response.json();
        }

        const retryableStatuses = new Set([403, 429, 500, 502, 503, 504]);
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        const shouldRetry = retryableStatuses.has(response.status) && attempt < maxAttempts;

        if (shouldRetry) {
            const backoffMs = Number.isFinite(retryAfterSeconds)
                ? Math.max(500, retryAfterSeconds * 1000)
                : 500 * attempt;
            await sleep(backoffMs);
            continue;
        }

        console.warn(`GitHub API error ${response.status} for ${repo}@${sha}`);
        return null;
    }

    return null;
}

async function processCommit(commit, payload, repo, branch) {
    const commitSha = commit.id || commit.sha;
    const details = await fetchCommitDetails(repo, commitSha);
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

    const payloadFiles = buildFilesFromPayload(commit);
    const files = details?.files?.length ? details.files : payloadFiles;

// === FILTER SETTINGS ===

    const allowedExtensions = [
        '.cs',
        '.cpp',
        '.c',
        '.h',
        '.hpp',
        '.py',
        '.java',
        '.js',
        '.ts',
        '.dart',
        '.glsl',
        '.shader'
    ];

    const ignoredDirectories = [
        'Library/',
        'Temp/',
        'Logs/',
        'Build/',
        'obj/',
        '.vs/',
        'Packages/'
    ];

// === FILTER FILES ===

    const filteredFiles = files.filter(file => {
        const filename = file.filename;

        // ignore directories
        if (ignoredDirectories.some(dir => filename.startsWith(dir))) {
            return false;
        }

        // allow only code files
        return allowedExtensions.some(ext =>
            filename.toLowerCase().endsWith(ext)
        );
    });

// === CALCULATE REAL LOC ===

    const hasFileAdditions = filteredFiles.some((file) => Number.isFinite(file.additions));
    const hasFileDeletions = filteredFiles.some((file) => Number.isFinite(file.deletions));

    const added = Number.isFinite(details?.stats?.additions)
        ? details.stats.additions
        : hasFileAdditions
            ? filteredFiles.reduce((sum, file) => sum + (file.additions || 0), 0)
            : null;

    const removed = Number.isFinite(details?.stats?.deletions)
        ? details.stats.deletions
        : hasFileDeletions
            ? filteredFiles.reduce((sum, file) => sum + (file.deletions || 0), 0)
            : null;

    const changedFiles = filteredFiles.length;

    const topFiles = filteredFiles.length
        ? [...filteredFiles]
            .sort((a, b) => getFileChangeScore(b) - getFileChangeScore(a))
            .slice(0, 3)
            .map((file) => `${file.filename} (${Number.isFinite(getFileChangeScore(file)) ? getFileChangeScore(file) : '?'})`)
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
        `Author: ${authorDisplay}    `,
        `Branch: ${branch || 'unknown'}`,
        `Hash: ${commitSha?.substring(0, 8) || 'unknown'}`,
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
            {
                name: 'Summary',
                value: clampText(summaryLines, 1024).split('\n').map((line) => `- ${line}`).join('\n'),
                inline: true
            },
            {
                name: 'Changes',
                value: clampText(changeLines, 1024).split('\n').map((line) => `- ${line}`).join('\n'),
                inline: true
            },
            {
                name: 'Top Files',
                value: clampText(topFiles.join('\n') || 'N/A', 1024).split('\n').map((line) => `- ${line}`).join('\n')
            }
        )
        .setFooter({text: payload.repository?.full_name || 'GitHub'})
        .setTimestamp(safeCommitDate);

    if (extras.length) {
        embed.addFields({name: 'Notes', value: extras.join(' | ')});
    }

    if (config.outputChannelId) {
        const channel = await client.channels.fetch(config.outputChannelId).catch(() => null);
        if (channel && isTextChannel(channel)) {
            await channel.send({embeds: [embed]});
        }
    }

    if (linkedDiscordId && added !== null && removed !== null) {
        const xpGain = added + removed * 0.6;
        const record = ensureUserRecord(config.users, linkedDiscordId);
        addXp(record, xpGain);
        saveConfig(config);
        await updateLeaderboard(client, config);
    }
}

function buildFilesFromPayload(commit) {
    const files = new Map();
    const pushFile = (filename, status) => {
        if (!filename) return;
        if (!files.has(filename)) {
            files.set(filename, {
                filename,
                status,
                additions: null,
                deletions: null,
                changes: null
            });
        }
    };

    (commit.added || []).forEach((filename) => pushFile(filename, 'added'));
    (commit.modified || []).forEach((filename) => pushFile(filename, 'modified'));
    (commit.removed || []).forEach((filename) => pushFile(filename, 'removed'));

    return [...files.values()];
}

function getFileChangeScore(file) {
    const additions = Number.isFinite(file.additions) ? file.additions : 0;
    const deletions = Number.isFinite(file.deletions) ? file.deletions : 0;
    if (Number.isFinite(file.changes)) return file.changes;
    return additions + deletions;
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
        limit: '25mb',
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

    const commits = payload.commit
        ? [payload.commit]          // new single-commit payload
        : (payload.commits || []); // old multi-commit payload

    for (const commit of commits) {
        try {
            await processCommit(commit, payload, repo, branch);
        } catch (error) {
            console.error('Failed to process commit:', error);
        }
    }
});

app.get('/ping', (req, res) => {
    res.send('pong');
});

const port = Number(process.env.PORT || 3000);



app.use((err, req, res, next) => {
    console.error(err);

    console.log("Payload size:", req.rawBody.length);
    
    if (err.type === 'entity.too.large') {
        return res.status(413).send('payload too large');
    }

    res.status(500).send('server error');
});



app.listen(port, () => {
    console.log(`Webhook server listening on ${port}`);
});



client.login(process.env.DISCORD_TOKEN);
