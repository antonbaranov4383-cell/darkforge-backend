import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import dotenv from 'dotenv'
import {Telegraf} from 'telegraf'
import Database from 'better-sqlite3'

dotenv.config()
const app=express();app.use(cors());app.use(express.json())
const BOT_TOKEN=process.env.BOT_TOKEN
const FRONTEND_URL=process.env.FRONTEND_URL
if(!BOT_TOKEN)throw new Error('BOT_TOKEN missing')
const bot=new Telegraf(BOT_TOKEN)

// БАЗА В ФАЙЛЕ - один файл на весь проект
const db=new Database('database.sqlite')
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, photo_url TEXT, balance INTEGER DEFAULT 0, energy INTEGER DEFAULT 1000, max_energy INTEGER DEFAULT 1000, tap_power INTEGER DEFAULT 1, auto_rate INTEGER DEFAULT 0, level INTEGER DEFAULT 1, xp INTEGER DEFAULT 0, taps INTEGER DEFAULT 0, crits INTEGER DEFAULT 0, upgrades TEXT DEFAULT '{"hammer":0,"energy":0,"regen":0,"golem":0,"crit":0}', buff_until TEXT DEFAULT '{}', referrer INTEGER, referrals INTEGER DEFAULT 0, last_seen INTEGER DEFAULT 0, daily_streak INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, item_id TEXT, stars INTEGER, payload TEXT UNIQUE, status TEXT, created_at INTEGER);
`)

function validate(initData){
  const p=new URLSearchParams(initData),hash=p.get('hash');p.delete('hash')
  const str=[...p.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>`${k}=${v}`).join('\n')
  const key=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest()
  return crypto.createHmac('sha256',key).update(str).digest('hex')===hash
}
const ITEMS={d1:{title:'Turbo Tap',stars:25,mins:60},d2:{title:'Infinite Energy',stars:50,mins:30},d3:{title:'Golem Legion',stars:100,mins:120},d4:{title:'GOD x5',stars:250,mins:60}}
function auth(req,res,next){const d=req.headers['x-telegram-initdata'];if(!d||!validate(d))return res.status(403).json({error:'bad hash'});req.tgUser=JSON.parse(new URLSearchParams(d).get('user'));next()}
function getOrCreate(u,ref){
  let user=db.prepare('SELECT * FROM users WHERE id=?').get(u.id)
  if(!user){
    db.prepare('INSERT INTO users (id,username,first_name,photo_url,referrer,last_seen) VALUES (?,?,?,?,?,?)').run(u.id,u.username||null,u.first_name,u.photo_url||null,ref,Date.now())
    if(ref) db.prepare('UPDATE users SET referrals=referrals+1, balance=balance+500 WHERE id=?').run(ref)
    user=db.prepare('SELECT * FROM users WHERE id=?').get(u.id)
  }
  return user
}
app.post('/api/auth',(req,res)=>{
  const d=req.headers['x-telegram-initdata'];if(!validate(d))return res.status(403).json({error:'bad'})
  const p=new URLSearchParams(d),u=JSON.parse(p.get('user')),s=p.get('start_param'),ref=s&&/^\d+$/.test(s)&&+s!==u.id?+s:null
  const user=getOrCreate(u,ref)
  const diff=Math.min((Date.now()-(user.last_seen||Date.now()))/1000,10800),earn=Math.floor(diff*(user.auto_rate||0))
  if(earn>0) db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(earn,u.id)
  db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(),u.id)
  res.json({...db.prepare('SELECT * FROM users WHERE id=?').get(u.id),offlineEarn:earn})
})
app.post('/api/tap',auth,(req,res)=>{
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.tgUser.id)
  if(u.energy<1)return res.status(400).json({error:'no energy'})
  db.prepare('UPDATE users SET balance=balance+?, energy=energy-1, taps=taps+1, xp=xp+? WHERE id=?').run(u.tap_power,u.tap_power,req.tgUser.id)
  res.json({earned:u.tap_power})
})
app.post('/api/create-invoice',auth,async(req,res)=>{
  const item=ITEMS[req.body.itemId];if(!item)return res.status(400).json({error:'bad item'})
  const payload='donate_'+req.tgUser.id+'_'+req.body.itemId+'_'+Date.now()
  db.prepare('INSERT INTO payments (user_id,item_id,stars,payload,status,created_at) VALUES (?,?,?,?,?,?)').run(req.tgUser.id,req.body.itemId,item.stars,payload,'pending',Date.now())
  const link=await bot.telegram.createInvoiceLink({title:item.title,description:item.title,payload,provider_token:"",currency:"XTR",prices:[{label:item.title,amount:item.stars}]})
  res.json({invoiceLink:link})
})
app.get('/api/leaderboard',(req,res)=>{res.json(db.prepare('SELECT id,username,first_name,balance,level FROM users ORDER BY balance DESC LIMIT 100').all())})
bot.on('pre_checkout_query',c=>c.answerPreCheckoutQuery(true))
bot.on('successful_payment',async ctx=>{
  const pay=ctx.message.successful_payment
  const p=db.prepare('SELECT * FROM payments WHERE payload=?').get(pay.invoice_payload)
  if(!p)return
  db.prepare('UPDATE payments SET status=? WHERE payload=?').run('paid',pay.invoice_payload)
  const item=ITEMS[p.item_id];ctx.reply('Баф '+item.title+' активирован на '+item.mins+'м')
})
bot.start(ctx=>ctx.reply('DARKFORGE WORLD',{reply_markup:{inline_keyboard:[[{text:'ИГРАТЬ',web_app:{url:FRONTEND_URL}}]]}}))
bot.launch().then(()=>console.log('Bot started'))
app.listen(process.env.PORT||3000,()=>console.log('API on '+process.env.PORT+' with file DB'))
