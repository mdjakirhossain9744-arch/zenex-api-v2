import Fastify from 'fastify';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { User, Order } from './models.js';
import fastifyFormbody from '@fastify/formbody'; 
import fastifyCors from '@fastify/cors'; 
import Redis from "ioredis"; 
import fastifyCompress from '@fastify/compress'; 

dotenv.config();

const fastify = Fastify({ logger: false, trustProxy: true });
const redis = new Redis(); 

fastify.register(fastifyCors, { 
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'mapikey', 'x-dashboard-user']
});

fastify.register(fastifyFormbody); 

fastify.register(fastifyCompress, {
    global: true,
    encodings: ['br', 'gzip', 'deflate'] 
});

const connectDB = async () => {
    try {
        const opts = { maxPoolSize: 150, minPoolSize: 10 };
        await mongoose.connect(process.env.MONGODB_URI, opts);
        console.log(`✅ ZENEX Database Connected to API Microservice [Instance: ${process.pid}]! 🚀`);
    } catch (error) {
        console.error('❌ Database Connection Failed:', error);
        process.exit(1);
    }
};

const getUTCDateString = (dateObj = new Date()) => new Date(dateObj).toISOString().split('T')[0];

// ==========================================
// 💥 IPRN ELITE JSON-RPC CONFIG 💥
// ==========================================
const IPRN_API_URL = "https://api.iprn-elite.com/v1.0";
const IPRN_API_KEY = process.env.IPRN_API_KEY || "1ddOYcGxRcWUlyi6T7oZzA"; 

let IPRN_TRUNK_ID = process.env.IPRN_TRUNK_ID || null;

const fetchIPRNTrunk = async () => {
    if (process.env.IPRN_TRUNK_ID) {
        IPRN_TRUNK_ID = process.env.IPRN_TRUNK_ID.trim();
        console.log(`🔥 IPRN Elite Connected! Trunk ID Loaded directly from .ENV: [${IPRN_TRUNK_ID}]`);
        return;
    }

    try {
        const payload = { jsonrpc: "2.0", method: "sms.trunk:get_list", params: {}, id: Date.now() };
        const res = await fetch(IPRN_API_URL, {
            method: "POST",
            headers: { "Api-Key": IPRN_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (data && data.result && data.result.trunk_list && data.result.trunk_list.length > 0) {
            const otpTrunk = data.result.trunk_list.find(t => t.name && t.name.toLowerCase() === "global access");
            IPRN_TRUNK_ID = otpTrunk ? otpTrunk.id : data.result.trunk_list[0].id;
            console.log(`🔥 IPRN Elite Connected! Auto-Fetched Trunk ID: [${IPRN_TRUNK_ID}]`);
        } else {
            console.warn("⚠️ IPRN Trunk list empty. Retrying...");
            setTimeout(fetchIPRNTrunk, 10000);
        }
    } catch (err) {
        setTimeout(fetchIPRNTrunk, 10000);
    }
};

const apiAuthCache = new Map();
const globalWorkerUserCache = new Map(); 
const userOtpResponseCache = new Map(); 

let cachedMaskingSettings = { keywords: [], expiry: 0 };
async function getMaskingKeywords() {
    if (Date.now() < cachedMaskingSettings.expiry) return cachedMaskingSettings.keywords;
    try {
        const db = mongoose.connection.db;
        const settings = await db.collection("system_settings").findOne({ type: "global" });
        const kw = settings?.hiddenKeywords || [];
        cachedMaskingSettings = { keywords: kw, expiry: Date.now() + 60000 }; 
        return kw;
    } catch (e) {
        return cachedMaskingSettings.keywords;
    }
}

const applyMasking = (text, keywords) => {
    if (!text) return text;
    let masked = text;
    keywords.forEach(w => {
        const word = w.trim();
        if (word && word.length > 1) {
            const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            masked = masked.replace(regex, (match) => match.replace(/[^\s]/g, '*'));
        }
    });
    return masked;
};

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of apiAuthCache.entries()) if (now > value.expiry) apiAuthCache.delete(key);
    for (const [key, value] of userOtpResponseCache.entries()) if (now > value.expiry) userOtpResponseCache.delete(key);
}, 30000); 

const extractServiceName = (msg) => {
    if (!msg) return "Other";
    const text = msg.toLowerCase();
    if (text.includes('facebook') || text.includes(' fb ') || text.includes('fb.me')) return 'Facebook';
    if (text.includes('whatsapp') || text.includes(' wa ') || text.includes('wa.me')) return 'WhatsApp';
    if (text.includes('telegram') || text.includes('t.me')) return 'Telegram';
    if (text.includes('instagram') || text.includes(' ig ') || text.includes('ig.me')) return 'Instagram';
    if (text.includes('google') || /g-\d+/.test(text) || text.includes('gmail')) return 'Google';
    if (text.includes('tiktok') || text.includes(' tt ')) return 'TikTok';
    if (text.includes('twitter') || text.includes(' x ')) return 'X';
    return "Other"; 
};

fastify.route({
    method: ['GET', 'POST'], 
    url: '/v1/getnum',
    handler: async (request, reply) => {
        try {
            const apiKey = request.headers['mapikey'] || (request.query && request.query.mapikey);
            if (!apiKey || apiKey.trim().length < 10) return reply.status(401).send({ meta: { status: "error" }, message: "Invalid API Key" });

            const cleanKey = apiKey.trim();
            let user;

            if (cleanKey === "ZENEX_INTERNAL_DASHBOARD_PASS") {
                const dashEmail = request.headers['x-dashboard-user'];
                if (!dashEmail) return reply.status(403).send({ meta: { status: "error" }, message: "Unauthorized Dashboard Request" });
                user = { email: dashEmail }; 
            } else {
                let cachedObj = apiAuthCache.get(cleanKey);
                if (!cachedObj || Date.now() > cachedObj.expiry) {
                    user = await User.findOne({ apiKey: cleanKey }).lean();
                    if (!user || !user.isApiActive || user.status !== "active") return reply.status(403).send({ meta: { status: "error" }, message: "Unauthorized API User" });
                    apiAuthCache.set(cleanKey, { user, expiry: Date.now() + 60000 });
                } else {
                    user = cachedObj.user;
                }
            }

            const reqData = request.body || request.query || {};
            const rawRange = typeof reqData === 'string' ? reqData : (reqData.range || "");
            const rid = rawRange.replace(/x/gi, '').trim();

            if (!rid) return reply.status(400).send({ meta: { status: "error" }, message: "Invalid Range Format" });

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); 
            request.raw.on('close', () => { if (request.raw.aborted) controller.abort(); });

            let response;
            try {
                // 💥 THE BOSS FIX: Removed `target.trunk_id` to force auto-routing by Provider API Key 💥
                const payload = {
                    jsonrpc: "2.0",
                    method: "allocation:template_by_account_user",
                    params: { 
                        template: String(rawRange).toUpperCase(),
                        numbers: 1
                    },
                    id: Date.now()
                };

                response = await fetch(IPRN_API_URL, {
                    method: "POST",
                    headers: { "Api-Key": IPRN_API_KEY, "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
            } catch (fetchError) {
                clearTimeout(timeoutId);
                return reply.status(504).send({ meta: { status: "error" }, message: "Provider is slow. Try again." });
            }

            let data;
            try { data = await response.json(); } catch(e) { return reply.status(502).send({ meta: { status: "error" }, message: "Invalid upstream response" }); }

            // 💥 REALTIME RESPONSE PARSING 💥
            if (data.result && data.result.reply === "success" && data.result.number && data.result.number.full) {
                const todayStr = getUTCDateString();
                const providerNumber = String(data.result.number.full); 
                const fullNum = providerNumber.includes('+') ? providerNumber.replace('+', '') : providerNumber;
                
                setImmediate(() => {
                    const newOrder = new Order({
                        userEmail: user.email,
                        searchNumber: fullNum,
                        displayNumber: `+${fullNum}`,
                        country: data.result.number.country_code || "Unknown",
                        operator: "Any",
                        status: "WAIT",
                        fullMessage: "Waiting...",
                        otp: "Waiting...", 
                        dateString: todayStr,
                        expireAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
                    });
                    newOrder.save().catch(() => {});
                });
                
                return reply.status(200).send({
                    meta: { status: "success", code: 200 },
                    data: {
                        copy: `+${fullNum}`,
                        number: `+${fullNum}`,
                        full_number: fullNum,
                        country: data.result.number.country_code || "Unknown",
                        iso: "Unknown",
                        operator: "Any",
                        status: "pending"
                    }
                });
            }

            console.error("⚠️ IPRN Rejection Log:", JSON.stringify(data));
            return reply.status(400).send({ 
                meta: { status: "error" }, 
                message: data.result?.reply || data.error?.message || "Out of stock or Invalid Range" 
            });
        } catch (error) {
            return reply.status(500).send({ meta: { status: "error" }, message: "Server Error" });
        }
    }
});

fastify.get('/v1/numsuccess/info', async (request, reply) => {
    try {
        const apiKey = request.headers['mapikey'];
        if (!apiKey || apiKey.trim().length < 10) return reply.status(401).send({ meta: { status: "error" }, message: "Missing API Key" });
        const cleanKey = apiKey.trim();

        const cachedOtpData = userOtpResponseCache.get(cleanKey);
        if (cachedOtpData && Date.now() < cachedOtpData.expiry) {
            return reply.status(200).send({ meta: { status: "success", code: 200 }, data: { otps: cachedOtpData.otps } });
        }

        let cachedObj = apiAuthCache.get(cleanKey);
        let user;

        if (!cachedObj || Date.now() > cachedObj.expiry) {
            user = await User.findOne({ apiKey: cleanKey }).select("email isApiActive").lean();
            if (user) apiAuthCache.set(cleanKey, { user, expiry: Date.now() + 60000 });
        } else {
            user = cachedObj.user;
        }

        if (!user || !user.isApiActive) return reply.status(401).send({ meta: { status: "error" }, message: "Unauthorized" });

        const hiddenKeywords = await getMaskingKeywords();
        const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
        
        const recentOrders = await Order.find({
            userEmail: user.email,
            status: "DONE", 
            updatedAt: { $gte: twentyMinutesAgo }
        }).select("_id displayNumber searchNumber otp fullMessage country operator updatedAt createdAt status").sort({ updatedAt: -1 }).lean();

        let expandedOtps = [];
        recentOrders.forEach(order => {
            const d = new Date(order.updatedAt || order.createdAt);
            const pad = (n) => n.toString().padStart(2, '0');
            const formattedDate = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
            const numberClean = String(order.displayNumber || order.searchNumber || "").replace(/\D/g, "");
            const baseNid = "ZX_" + order._id.toString().substring(0, 10).toUpperCase();

            let rawMsg = order.fullMessage || order.otp || "";
            if (rawMsg.includes("_||_")) {
                const msgsArray = rawMsg.split("_||_").map(m => m.trim()).filter(Boolean);
                msgsArray.forEach((msg, idx) => {
                    expandedOtps.push({ 
                        nid: `${baseNid}_${idx}`, number: numberClean, otp: applyMasking(msg, hiddenKeywords), 
                        country: order.country || "Unknown", operator: order.operator || "Any", created_at: formattedDate 
                    });
                });
            } else {
                expandedOtps.push({ 
                    nid: `${baseNid}_0`, number: numberClean, otp: applyMasking(rawMsg, hiddenKeywords), 
                    country: order.country || "Unknown", operator: order.operator || "Any", created_at: formattedDate 
                });
            }
        });

        const validOtps = expandedOtps.filter(o => o.otp && o.otp.trim() !== "" && !["waiting...", "pending", "null"].includes(o.otp.toLowerCase()));
        userOtpResponseCache.set(cleanKey, { otps: validOtps, expiry: Date.now() + 1500 });
        
        return reply.status(200).send({ meta: { status: "success", code: 200 }, data: { otps: validOtps } });
    } catch (error) { return reply.status(500).send({ meta: { status: "error" } }); }
});

let cachedActiveData = null;
let lastFetchTime = 0;
const CACHE_DURATION = 60 * 1000; 

fastify.get('/v1/active-ranges', async (request, reply) => {
    try {
        if (cachedActiveData && (Date.now() - lastFetchTime < CACHE_DURATION)) {
            return reply.send({ success: true, cached: true, data: cachedActiveData });
        }

        const hiddenKeywords = await getMaskingKeywords();
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const recentOrders = await Order.find({ status: { $in: ["DONE", "Success", "SUCCESS"] }, updatedAt: { $gte: oneHourAgo } }).select("fullMessage otp searchNumber number").lean();
        const rangeMap = {};

        recentOrders.forEach((o) => {
            let msg = o.fullMessage || o.otp || "";
            const rawService = extractServiceName(msg);
            const maskedService = applyMasking(rawService, hiddenKeywords); 

            let num = o.searchNumber || o.number || "";
            num = String(num).replace("+", "");
            
            if (num.length >= 6) {
                const rangeStr = num.substring(0, 6) + "XXX"; 
                const key = `${rangeStr}|${maskedService}`;
                if (!rangeMap[key]) rangeMap[key] = { range: rangeStr, service: maskedService, hits: 0 };
                rangeMap[key].hits += 1;
            }
        });

        const formattedRanges = Object.values(rangeMap).sort((a, b) => b.hits - a.hits).slice(0, 10);
        cachedActiveData = { active_ranges: formattedRanges };
        lastFetchTime = Date.now();

        return reply.send({ success: true, cached: false, data: cachedActiveData });
    } catch (error) { return reply.status(500).send({ success: false, message: "Server Error" }); }
});

const startServer = async () => {
    try {
        await connectDB();
        await fetchIPRNTrunk(); 
        await fastify.listen({ port: process.env.PORT || 5000, host: '0.0.0.0' });
        console.log(`⚡ ZENEX Microservice V2 is LIVE at: http://localhost:${process.env.PORT || 5000}`);
    } catch (err) { process.exit(1); }
};
startServer();