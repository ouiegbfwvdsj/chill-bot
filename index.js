// index.js
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder
} = require("discord.js");
const fs = require("fs");
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID || null;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ----- 設定 -----
const ANNOUNCE_CHANNEL_ID = "1401813155310473289"; // 通知用チャンネル
const DATA_FILE = "./eventData.json";
const VC_ID = "1290692251458076677";
const VC_CHECK_INTERVAL = 60 * 1000; // 1分
const VC_COOLDOWN = 3 * 60 * 60 * 1000; // 3時間
let lastVCAnnounce = 0;

// データ読み込み
let eventData = {};
if (fs.existsSync(DATA_FILE)) {
  try { eventData = JSON.parse(fs.readFileSync(DATA_FILE)); } catch(e){ console.error("eventData.json 読み込み失敗:", e); eventData = {}; }
}
function saveData() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(eventData,null,2)); } catch(e){ console.error("saveData エラー:", e); }}

// ----- Embed作成 -----
function createEventEmbedStored(eventStored, participants=[], status="active"){
  let title = `📢 新しいイベント: ${eventStored.name}`;
  let color = 0x00ae86;
  if(status==="cancelled"){ title="このイベントはキャンセルされました"; color=0xff0000; }
  else if(status==="ended"){ title="このイベントは終了しました"; color=0x808080; }

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(`**作成者:** ${eventStored.creator}\n${eventStored.description||"説明なし"}`)
    .addFields(
      { name:"開始時間", value:`<t:${Math.floor(eventStored.startTimestamp/1000)}:F>` },
      { name:"開催VC", value:eventStored.vcName||"未設定", inline:true },
      { name:"参加者", value:participants.length>0?participants.join("\n"):"まだ誰も参加していません", inline:false }
    )
    .setURL(`https://discord.com/events/${eventStored.guildId}/${eventStored.eventId}`)
    .setColor(color);
}

// ボタン行
function createActionRow(eventId){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`join_${eventId}`).setLabel("✅ 参加").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`leave_${eventId}`).setLabel("❌ 不参加").setStyle(ButtonStyle.Danger)
  );
}

// ----- VCチェック -----
async function announceVCStatusText(vc, nonBotMembers, announceChannel){
  const msg = `ステータス書いてね`; // そのまま残す
  await announceChannel.send(msg);
}

async function checkVC(){
  try{
    const guild = client.guilds.cache.first();
    if(!guild) return;

    const vc = guild.channels.cache.get(VC_ID);
    if(!vc) return;
    const isVoice = typeof vc.isVoiceBased==='function'?vc.isVoiceBased():(vc.type===ChannelType.GuildVoice||vc.type===2);
    if(!isVoice) return;

    const nonBotMembers = vc.members.filter(m=>!m.user.bot);
    if(nonBotMembers.size<2) return;

    const now = Date.now();
    if(now - lastVCAnnounce < VC_COOLDOWN) return;

    const announceChannel = guild.channels.cache.get(ANNOUNCE_CHANNEL_ID);
    if(!announceChannel || !announceChannel.isTextBased()) return;

    await announceVCStatusText(vc, nonBotMembers, announceChannel);
    lastVCAnnounce = now;
  } catch(err){
    console.error("VCチェックエラー:",err);
  }
}

// ----- イベント管理 -----
client.on("guildScheduledEventCreate", async (event)=>{
  try{
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
    if(!channel || !channel.isTextBased?.()) return;

    let creator = event.creator?.username;
    if(!creator){
      const guild = await client.guilds.fetch(event.guildId);
      const fullGuild = await guild.fetch();
      creator = fullGuild.ownerId?(await fullGuild.members.fetch(fullGuild.ownerId)).user.username:"不明";
    }

    const vcName = event.channelId?event.guild.channels.cache.get(event.channelId)?.name||"未設定":"未設定";

    eventData[event.id] = {
      messageId:null, participants:[], creator,
      name:event.name, description:event.description,
      startTimestamp:event.scheduledStartTimestamp, endTimestamp:event.scheduledEndTimestamp||null,
      vcName, guildId:event.guildId, eventId:event.id, status:"active"
    };

    const embed = createEventEmbedStored(eventData[event.id],[], "active");
    const msg = await channel.send({ content:"@everyone 新しいイベントが作成されました！", embeds:[embed], components:[createActionRow(event.id)] });
    eventData[event.id].messageId = msg.id;
    saveData();
  } catch(err){ console.error("イベント作成エラー:",err); }
});

// ボタン
client.on("interactionCreate", async (interaction)=>{
  if(interaction.isButton()){
    try{
      const [action,eventId] = interaction.customId.split("_");
      const data = eventData[eventId];
      if(!data || data.status!=="active"){
        await interaction.reply({ content:"このイベントは参加できません。", ephemeral:true });
        return;
      }

      const participants = data.participants;
      if(action==="join"){ if(!participants.includes(interaction.user.username)) participants.push(interaction.user.username); }
      else if(action==="leave"){ const index=participants.indexOf(interaction.user.username); if(index>-1) participants.splice(index,1); }

      const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
      const msg = await channel.messages.fetch(data.messageId).catch(()=>null);
      if(!msg) return console.error("メッセージ取得失敗");

      const embed = createEventEmbedStored(data, participants,"active");
      await msg.edit({ content:"@everyone 新しいイベントが作成されました！", embeds:[embed], components:[createActionRow(eventId)] });
      saveData();
      await interaction.reply({ content:"参加者リストを更新しました！", ephemeral:true });
    } catch(err){ console.error("ボタン処理エラー:",err); }
  }
});

// キャンセル/終了判定
client.on("guildScheduledEventDelete", async (event)=>{
  const data = eventData[event.id]; if(!data) return;
  const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
  const msg = await channel.messages.fetch(data.messageId).catch(()=>null);
  if(msg){
    const embed = createEventEmbedStored(data,data.participants,"cancelled");
    await msg.edit({ content:"このイベントはキャンセルされました", embeds:[embed], components:[] });
  }
  data.status="cancelled"; saveData();
});

client.on("guildScheduledEventUpdate", async (oldEvent,newEvent)=>{
  const data = eventData[newEvent.id]; if(!data || data.status!=="active") return;
  const now = Date.now();
  if(newEvent.scheduledEndTimestamp && now>newEvent.scheduledEndTimestamp){
    const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
    const msg = await channel.messages.fetch(data.messageId).catch(()=>null);
    if(msg){
      const embed = createEventEmbedStored(data,data.participants,"ended");
      await msg.edit({ content:"このイベントは終了しました", embeds:[embed], components:[] });
    }
    data.status="ended"; saveData();
  }
});

// ----- スラッシュコマンド -----
const commands = [
  new SlashCommandBuilder().setName("dice").setDescription("🎲 サイコロを振ります (1〜6)"),
  new SlashCommandBuilder().setName("ping").setDescription("📡 Botの応答速度を確認します"),
  new SlashCommandBuilder().setName("uptime").setDescription("⏱ Botの稼働時間を表示します"),
  new SlashCommandBuilder().setName("botinfo").setDescription("🤖 Botの詳細情報を表示します"),
  new SlashCommandBuilder().setName("serverinfo").setDescription("🏠 サーバーの詳細情報を表示します"),
  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("👤 ユーザー情報を表示します")
    .addUserOption(option => option.setName("target").setDescription("調べるユーザー").setRequired(false)),
  new SlashCommandBuilder().setName("eventlist").setDescription("📋 アクティブなイベント一覧を表示します"),
  new SlashCommandBuilder()
    .setName("eventinfo")
    .setDescription("📌 指定イベントの詳細を表示します")
    .addStringOption(opt => opt.setName("id").setDescription("イベントID").setRequired(true)),
  new SlashCommandBuilder()
    .setName("ai")
    .setDescription("💬 Gemini AI に質問できます")
    .addStringOption(opt => opt.setName("prompt").setDescription("質問内容").setRequired(true)),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("ヘルプを表示します"),
].map(c => c.toJSON());


// ----- ready -----
client.once("clientReady", async () => {
  console.log(`✅ ログイン完了: ${client.user.tag}`);

  // ステータス設定
  try {
    await client.user.setActivity("/help", { type: "PLAYING" });
    console.log("✅ ステータス設定完了: プレイ中 /help");
  } catch (e) {
    console.error("ステータス設定失敗:", e);
  }

  // コマンド登録
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
      );
      console.log(`✅ ギルド ${GUILD_ID} にコマンド登録`);
    } else {
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands }
      );
      console.log("✅ グローバル登録（反映最大1時間）");
    }
  } catch (err) {
    console.error("コマンド登録エラー:", err);
  }

  // VC監視開始
  setInterval(checkVC, VC_CHECK_INTERVAL);
});


// ----- スラッシュコマンド処理 -----
client.on("interactionCreate", async (interaction)=>{
  try{
    if(!interaction.isCommand()) return;

    if(interaction.commandName==="dice"){
      const roll=Math.floor(Math.random()*6)+1;
      await interaction.reply(`🎲 サイコロの目は **${roll}** です！`);
      return;
    }

    if(interaction.commandName==="ping"){
      const sent = await interaction.reply({ content:"🏓 計測中...", fetchReply:true });
      const latency = sent.createdTimestamp - interaction.createdTimestamp;
      const apiLatency = Math.round(client.ws.ping);
      await interaction.editReply(`🏓 Pong!\n・応答速度: **${latency}ms**\n・API レイテンシ: **${apiLatency}ms**`);
      return;
    }

    if(interaction.commandName==="uptime"){
      const totalSeconds = Math.floor(process.uptime());
      const hours = Math.floor(totalSeconds/3600);
      const minutes = Math.floor((totalSeconds%3600)/60);
      const seconds = totalSeconds%60;
      await interaction.reply(`⏱ 稼働時間: **${hours}時間 ${minutes}分 ${seconds}秒**`);
      return;
    }

    if(interaction.commandName==="botinfo"){
      await client.application.fetch().catch(()=>null);
      const owner = client.application?.owner ? (client.application.owner.name||client.application.owner.tag) : "不明";
      const guildCount = client.guilds.cache.size;
      const totalMembers = client.guilds.cache.reduce((acc,g)=>acc+(g.memberCount||0),0);
      const embed = new EmbedBuilder()
        .setTitle("🤖 Bot 情報")
        .addFields(
          { name:"Bot名", value:`${client.user.tag}`, inline:true },
          { name:"Bot ID", value:`${client.user.id}`, inline:true },
          { name:"Owner", value:`${owner}`, inline:true },
          { name:"参加サーバー数", value:`${guildCount}`, inline:true },
          { name:"合計メンバー数（概算）", value:`${totalMembers}`, inline:true },
          { name:"ライブラリ", value:`discord.js v${require("discord.js").version}`, inline:true },
          { name:"起動時間", value:`<t:${Math.floor(client.uptime?(Date.now()-client.uptime)/1000:(Date.now()/1000))}:R>`, inline:false }
        )
        .setColor(0x00aaff)
        .setThumbnail(client.user.displayAvatarURL());
      await interaction.reply({ embeds:[embed] });
      return;
    }

    if(interaction.commandName==="serverinfo"){
      const guild = interaction.guild;
      if(!guild) return interaction.reply("サーバー内のみ使用可能");
      let ownerTag = "不明";
      try{ const owner = await guild.fetchOwner(); ownerTag = owner.user.tag; } catch(e){}
      const textChannels = guild.channels.cache.filter(c=>c.isTextBased()).size;
      const voiceChannels = guild.channels.cache.filter(c=>c.isVoiceBased()).size;
      const roleCount = guild.roles.cache.size;
      const memberCount = guild.memberCount;
      const onlineCount = guild.members.cache.filter(m=>m.presence && ["online","idle","dnd"].includes(m.presence.status)).size;

      const embed = new EmbedBuilder()
        .setTitle(`🏠 サーバー情報: ${guild.name}`)
        .addFields(
          { name:"サーバーID", value:`${guild.id}`, inline:true },
          { name:"オーナー", value:`${ownerTag}`, inline:true },
          { name:"メンバー数", value:`${memberCount}`, inline:true },
          { name:"オンライン数（キャッシュ）", value:`${onlineCount}`, inline:true },
          { name:"テキストチャンネル数", value:`${textChannels}`, inline:true },
          { name:"ボイスチャンネル数", value:`${voiceChannels}`, inline:true },
          { name:"ロール数", value:`${roleCount}`, inline:true },
          { name:"作成日", value:`<t:${Math.floor(guild.createdTimestamp/1000)}:F>`, inline:false }
        )
        .setColor(0x0099ff)
        .setThumbnail(guild.iconURL());
      await interaction.reply({ embeds:[embed] });
      return;
    }

    if(interaction.commandName==="userinfo"){
      const target = interaction.options.getUser("target") || interaction.user;
      let member = null;
      if(interaction.guild){
        try{ member = await interaction.guild.members.fetch(target.id); } catch(e){}
      }
      const roles = member?member.roles.cache.filter(r=>r.id!==interaction.guild.id).map(r=>r.name).slice(0,12):[];
      const embed = new EmbedBuilder()
        .setTitle(`👤 ユーザー情報: ${target.tag}`)
        .setThumbnail(target.displayAvatarURL({ dynamic:true }))
        .addFields(
          { name:"ユーザー名", value:`${target.username}`, inline:true },
          { name:"タグ", value:`#${target.discriminator}`, inline:true },
          { name:"ユーザーID", value:`${target.id}`, inline:true },
          { name:"アカウント作成日", value:`<t:${Math.floor(target.createdTimestamp/1000)}:F>`, inline:false }
        )
        .setColor(0x00ccff);

      if(member){
        embed.addFields(
          { name:"サーバー内表示名", value:`${member.displayName}`, inline:true },
          { name:"参加日時", value:member.joinedAt?`<t:${Math.floor(member.joinedTimestamp/1000)}:F>`:"不明", inline:true },
          { name:"ロール（上位12個）", value:roles.length>0?roles.join(", "):"なし", inline:false }
        );
        const presence = member.presence?member.presence.status||"不明":"不明";
        embed.addFields({ name:"プレゼンス（キャッシュ）", value:`${presence}`, inline:true });
      }
      await interaction.reply({ embeds:[embed] });
      return;
    }

    if(interaction.commandName==="eventlist"){
      const active = Object.values(eventData).filter(e=>e.status==="active");
      if(active.length===0) return interaction.reply("現在アクティブなイベントはありません。");
      const list = active.map(e=>`• **${e.name}** (ID: \`${e.eventId}\`) — 作成者: ${e.creator} — 参加: ${e.participants.length}`).join("\n");
      await interaction.reply({ content:list });
      return;
    }

    if(interaction.commandName==="eventinfo"){
      const id = interaction.options.getString("id");
      const e = eventData[id];
      if(!e) return interaction.reply("そのIDのイベントは見つかりません。");
      const embed = createEventEmbedStored(e,e.participants,e.status);
      await interaction.reply({ embeds:[embed] });
      return;
    }

   if (interaction.commandName === "help") {
      await interaction.reply({ content: "ヘルプなんてねえよ", ephemeral: true });
      return;
    }

 // ★ Gemini AI
const fs = require("fs");
const path = require("path");

// ===== AI利用回数（全員共通） =====
const usageFile = path.join(__dirname, "aiUsage.json");
const MAX_USAGE_PER_DAY = 250;

// ファイルから読み込み（存在しなければ初期化）
let aiUsage = { count: 0, lastReset: new Date().toDateString() };
if (fs.existsSync(usageFile)) {
  try {
    const data = JSON.parse(fs.readFileSync(usageFile, "utf8"));
    if (data && typeof data.count === "number" && data.lastReset) {
      aiUsage = data;
    }
  } catch (e) {
    console.error("⚠️ aiUsage.json の読み込みに失敗しました。初期化します。");
  }
}

// 保存関数
function saveUsage() {
  fs.writeFileSync(usageFile, JSON.stringify(aiUsage, null, 2), "utf8");
}

// ===== /ai コマンド =====
if (interaction.commandName === "ai") {
  const today = new Date().toDateString();

  // 日付が変わったらリセット
  if (aiUsage.lastReset !== today) {
    aiUsage.count = 0;
    aiUsage.lastReset = today;
    saveUsage();
  }

  // 上限チェック
  if (aiUsage.count >= MAX_USAGE_PER_DAY) {
    await interaction.reply("⚠️ 本日のAI利用回数が上限 **250** に達しました。");
    return;
  }

  const userPrompt = interaction.options.getString("prompt");
  try {
    await interaction.deferReply();

    const result = await model.generateContent({
      contents: [{
        role: "user",
        parts: [{ text: `\n${userPrompt}` }]
      }]
    });

    const response = result.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!response) {
      await interaction.editReply("⚠️ 応答を生成できませんでした。");
      return;
    }

    // 成功したのでカウントを増やして保存
    aiUsage.count++;
    saveUsage();

    const remaining = MAX_USAGE_PER_DAY - aiUsage.count;

    // 長文対応
    const chunks = response.match(/[\s\S]{1,1900}/g) || [];
    const firstMessage =
      `**${interaction.user.tag}**\n> ${userPrompt}\n\n**回答**\n${chunks[0]}\n\n⚡残り利用可能回数**${remaining}** / ${MAX_USAGE_PER_DAY}`;
    await interaction.editReply(firstMessage);

    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }

  } catch (error) {
    console.error("Gemini AI エラー:", error);
    if (error.status === 503) {
      await interaction.editReply("⚠️ AIサービスが現在、過負荷状態です。数分後にもう一度試してください。");
    } else {
      await interaction.editReply("⚠️ AI応答中にエラーが発生しました。");
    }
  }
}






  } catch(err){
    console.error("スラッシュ処理エラー:",err);
    if(interaction && !interaction.replied){
      try{ await interaction.reply({ content:"エラーが発生しました (ログ参照)", ephemeral:true }); } catch{}
    }
  }
});

// ----- 起動 -----
client.login(BOT_TOKEN).catch(err=>console.error("ログイン失敗:",err));
//いひひひひひひひひひひ　