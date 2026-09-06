import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import dotenv from 'dotenv'
import {Telegraf} from 'telegraf'
import pg from 'pg'
dotenv.config()
const app=express();app.use(cors());app.use(express.json())
const BOT_TOKEN=process.env.BOT_TOKEN
const FRONTEND_URL=process.env.FRONTEND_URL
if(!BOT_TOKEN)throw new Error('BOT_TOKEN missing')
const bot=new Telegraf(BOT_TOKEN)
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}})
await pool.query(`
CREATE TABLE IF NOT EXISTS users (id BIGINT PRIMARY KEY, username TEXT, first_name TEXT, photo_url TEXT, balance BIGINT DEFAULT 0, energy INT DEFAULT 1000, max_energy INT DEFAULT 1000, tap_power INT DEFAULT 1, auto_rate INT DEFAULT 0, level INT DEFAULT 1, xp BIGINT DEFAULT 0, taps BIGINT DEFAULT 0, crits INT DEFAULT 0, upgrades JSONB DEFAULT '{"hammer":0,"energy":0,"regen":0,"golem":0,"crit":0}', buff_until JSONB DEFAULT '{}', referrer BIGINT, referrals INT DEFAULT 0, last_seen BIGINT DEFAULT 0, daily_streak INT DEFAULT 0, last_daily BIGINT DEFAULT 0);
CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, user_id BIGINT, item_id TEXT, stars INT, payload TEXT UNIQUE, status TEXT, created_at BIGINT);
CREATE TABLE IF NOT EXISTS leaderboard (id BIGINT PRIMARY KEY, balance BIGINT);
`)
function validate(initData){
  const p=new URLSearchParams(initData),hash=p.get('hash');p.delete('hash')
  const str=[...p.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>`${k}=${v}`).join('\n')
  const key=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest()
  return crypto.createHmac('sha256',key).update(str).digest('hex')===hash
}
const ITEMS={d1:{title:'Turbo Tap',stars:25,buff:{tap:3,mins:60}},d2:{title:'Infinite Energy',stars:50,buff:{mins:30,energy:1}},d3:{title:'Golem Legion',stars:100,buff:{golem:5,mins:120}},d4:{title:'GOD x5',stars:250,buff:{mult:5,mins:60}}}
function auth(req,res,next){const d=req.headers['x-telegram-initdata'];if(!d||!validate(d))return res.status(403).json({error:'bad hash'});req.tgUser=JSON.parse(new URLSearchParams(d).get('user'));next()}
async function getOrCreate(u,ref){let r=await pool.query('SELECT * FROM users WHERE id=$1',[u.id]);if(!r.rows.length){await pool.query('INSERT INTO users (id,username,first_name,photo_url,referrer,last_seen) VALUES ($1,$2,$3,$4,$5,$6)',[u.id,u.username||null,u.first_name,u.photo_url||null,ref,Date.now()]);if(ref)await pool.query('UPDATE users SET referrals=referrals+1, balance=balance+500 WHERE id=$1',[ref]);r=await pool.query('SELECT * FROM users WHERE id=$1',[u.id])}return r.rows[0]}
app.post('/api/auth',async(req,res)=>{const d=req.headers['x-telegram-initdata'];if(!validate(d))return res.status(403).json({error:'bad'});const p=new URLSearchParams(d),u=JSON.parse(p.get('user')),s=p.get('start_param'),ref=s&&/^\d+$/.test(s)&&+s!==u.id?+s:null;const user=await getOrCreate(u,ref);const diff=Math.min((Date.now()-(user.last_seen||Date.now()))/1000,10800),earn=Math.floor(diff*(user.auto_rate||0));if(earn>0)await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2',[earn,u.id]);await pool.query('UPDATE users SET last_seen=$1 WHERE id=$2',[Date.now(),u.id]);res.json({...user,offlineEarn:earn})})
app.post('/api/tap',auth,async(req,res)=>{const u=(await pool.query('SELECT * FROM users WHERE id=$1',[req.tgUser.id])).rows[0];if(u.energy<1)return res.status(400).json({error:'no energy'});await pool.query('UPDATE users SET balance=balance+$1, energy=energy-1, taps=taps+1, xp=xp+$1 WHERE id=$2',[u.tap_power,req.tgUser.id]);res.json({earned:u.tap_power})})
app.post('/api/create-invoice',auth,async(req,res)=>{const item=ITEMS[req.body.itemId];if(!item)return res.status(400).json({error:'bad item'});const payload='donate_'+req.tgUser.id+'_'+req.body.itemId+'_'+Date.now();await pool.query('INSERT INTO payments (user_id,item_id,stars,payload,status,created_at) VALUES ($1,$2,$3,$4,$5,$6)',[req.tgUser.id,req.body.itemId,item.stars,payload,'pending',Date.now()]);const link=await bot.telegram.createInvoiceLink({title:item.title,description:item.title,payload,provider_token:"",currency:"XTR",prices:[{label:item.title,amount:item.stars}]});res.json({invoiceLink:link})})
app.get('/api/leaderboard',async(req,res)=>{const r=await pool.query('SELECT id,username,first_name,balance,level FROM users ORDER BY balance DESC LIMIT 100');res.json(r.rows)})
bot.on('pre_checkout_query',c=>c.answerPreCheckoutQuery(true))
bot.on('successful_payment',async ctx=>{const pay=ctx.message.successful_payment,p=(await pool.query('SELECT * FROM payments WHERE payload=$1',[pay.invoice_payload])).rows[0];if(!p)return;await pool.query('UPDATE payments SET status=$1 WHERE payload=$2',['paid',pay.invoice_payload]);const item=ITEMS[p.item_id];let buffs=(await pool.query('SELECT buff_until FROM users WHERE id=$1',[p.user_id])).rows[0].buff_until||{};if(typeof buffs==='string')buffs=JSON.parse(buffs);const until=Date.now()+item.buff.mins*60000;if(item.buff.tap)buffs.tap=until;if(item.buff.mult)buffs.god=until;await pool.query('UPDATE users SET buff_until=$1 WHERE id=$2',[JSON.stringify(buffs),p.user_id]);if(item.buff.golem)await pool.query('UPDATE users SET auto_rate=auto_rate+$1 WHERE id=$2',[item.buff.golem,p.user_id]);ctx.reply('Баф '+item.title+' активирован на '+item.buff.mins+'м')})
bot.start(ctx=>ctx.reply('DARKFORGE WORLD',{reply_markup:{inline_keyboard:[[{text:'ИГРАТЬ',web_app:{url:FRONTEND_URL}}]]}}))
bot.launch().then(()=>console.log('Bot started'))
app.listen(process.env.PORT||3000,()=>console.log('API on '+process.env.PORT))
