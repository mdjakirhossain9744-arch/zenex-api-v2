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

let IPRN_SMS_TRUNK_ID = process.env.IPRN_SMS_TRUNK_ID || null;

const fetchIPRNTrunk = async () => {
    if (process.env.IPRN_SMS_TRUNK_ID) {
        IPRN_SMS_TRUNK_ID = process.env.IPRN_SMS_TRUNK_ID.trim();
        console.log(`🔥 IPRN Elite Connected! SMS Trunk ID Loaded directly from .ENV: [${IPRN_SMS_TRUNK_ID}]`);
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
            IPRN_SMS_TRUNK_ID = otpTrunk ? otpTrunk.id : data.result.trunk_list[0].id;
            console.log(`🔥 IPRN Elite Connected! SMS Trunk ID Loaded: [${IPRN_SMS_TRUNK_ID}]`);
        } else {
            console.warn("⚠️ IPRN Trunk list is empty. Retrying in 10s...");
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
    if (text.includes('facebook') || text.includes(' fb ')) return 'Facebook';
    if (text.includes('whatsapp') || text.includes(' wa ')) return 'WhatsApp';
    if (text.includes('telegram') || text.includes('t.me')) return 'Telegram';
    if (text.includes('instagram') || text.includes(' ig ')) return 'Instagram';
    if (text.includes('google') || text.includes('gmail')) return 'Google';
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

            if (!IPRN_SMS_TRUNK_ID) return reply.status(503).send({ meta: { status: "error" }, message: "System Initializing. Please wait." });

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 12000); 
            request.raw.on('close', () => { if (request.raw.aborted) controller.abort(); });

            const reqData = request.body || request.query || {};
            const rawRange = typeof reqData === 'string' ? reqData : (reqData.range || "");
            const rid = rawRange.replace(/x/gi, '').trim();

            if (!rid) {
                clearTimeout(timeoutId);
                return reply.status(400).send({ meta: { status: "error" }, message: "Invalid Range Format" });
            }

            let response;
            try {
                // 💥 STEP 1: ALLOCATION 💥
                const payload = {
                    jsonrpc: "2.0",
                    method: "sms.allocation:template_by_account_user",
                    params: { 
                        target: { "sms.trunk_id": IPRN_SMS_TRUNK_ID },
                        template: String(rawRange).toUpperCase(),
                        numbers: 1,
                        random_number: true
                    },
                    id: Date.now()
                };

                response = await fetch(IPRN_API_URL, {
                    method: "POST",
                    headers: { "Api-Key": IPRN_API_KEY, "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
            } catch (fetchError) {
                clearTimeout(timeoutId);
                return reply.status(504).send({ meta: { status: "error" }, message: "Provider is slow. Try again." });
            }

            let data;
            try { data = await response.json(); } catch(e) { 
                clearTimeout(timeoutId);
                return reply.status(502).send({ meta: { status: "error" }, message: "Invalid upstream response" }); 
            }

            // 💥 STEP 2: FETCH ACTUAL NUMBER 💥
            if (data.result && data.result.trunk_number_transaction && data.result.trunk_number_transaction.id) {
                const trxId = data.result.trunk_number_transaction.id;
                console.log(`✅ [SUCCESS] Number Allocated! Transaction ID: ${trxId}`);
                
                try {
                    const fetchNumPayload = {
                        jsonrpc: "2.0",
                        method: "sms.trunk_number:get_list",
                        params: { 
                            trunk_id: IPRN_SMS_TRUNK_ID, // FORCING TRUNK ID
                            trunk_number_transaction_id: trxId 
                        },
                        id: Date.now()
                    };

                    const numRes = await fetch(IPRN_API_URL, {
                        method: "POST",
                        headers: { "Api-Key": IPRN_API_KEY, "Content-Type": "application/json" },
                        body: JSON.stringify(fetchNumPayload),
                        signal: controller.signal
                    });
                    
                    const numData = await numRes.json();
                    console.log(`🔍 [DEBUG] Step 2 Fetch Response:`, JSON.stringify(numData)); // 🚨 VERY IMPORTANT LOG
                    
                    let trunkObj = null;

                    if (numData.result && numData.result.trunk_number_list && numData.result.trunk_number_list.length > 0) {
                        trunkObj = numData.result.trunk_number_list[0];
                    } else {
                        console.log(`⚠️ [WARN] Step 2 empty list. Trying Fallback...`);
                        const fallbackPayload = {
                            jsonrpc: "2.0",
                            method: "sms.trunk_number:get_list",
                            params: { trunk_id: IPRN_SMS_TRUNK_ID },
                            id: Date.now()
                        };
                        const fallRes = await fetch(IPRN_API_URL, { method: "POST", headers: { "Api-Key": IPRN_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(fallbackPayload) });
                        const fallData = await fallRes.json();
                        console.log(`🔍 [DEBUG] Fallback Response:`, JSON.stringify(fallData));
                        
                        if (fallData.result && fallData.result.trunk_number_list && fallData.result.trunk_number_list.length > 0) {
                            trunkObj = fallData.result.trunk_number_list[0];
                        }
                    }

                    clearTimeout(timeoutId);

                    // EXTRACTING THE ACTUAL NUMBER STRING
                    let assignedNumber = trunkObj?.number || trunkObj?.full_number || trunkObj?.number?.full || null;

                    if (assignedNumber) {
                        const todayStr = getUTCDateString();
                        const providerNumber = String(assignedNumber); 
                        const fullNum = providerNumber.includes('+') ? providerNumber.replace('+', '') : providerNumber;
                        const country = trunkObj.country_name || trunkObj.country_code || "Unknown";
                        
                        setImmediate(() => {
                            const newOrder = new Order({
                                userEmail: user.email,
                                searchNumber: fullNum,
                                displayNumber: `+${fullNum}`,
                                country: country,
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
                                country: country,
                                iso: "Unknown",
                                operator: "Any",
                                status: "pending"
                            }
                        });
                    } else {
                        console.error("❌ [ERROR] Number object is missing the number field:", JSON.stringify(trunkObj));
                        return reply.status(500).send({ meta: { status: "error" }, message: "Number assigned but retrieval string failed." });
                    }
                } catch (numErr) {
                    clearTimeout(timeoutId);
                    console.error("❌ [ERROR] Exception in Step 2:", numErr.message);
                    return reply.status(500).send({ meta: { status: "error" }, message: "Failed to retrieve allocated number details." });
                }
            }

            clearTimeout(timeoutId);
            console.error("⚠️ IPRN Rejection Log:", JSON.stringify(data));
            return reply.status(400).send({ 
                meta: { status: "error" }, 
                message: data.error?.message || "Out of stock or Invalid Range" 
            });
        } catch (error) {
            console.error("❌ [ERROR] Global Try-Catch:", error.message);
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

const startServer = async () => {
    try {
        await connectDB();
        await fetchIPRNTrunk(); 
        await fastify.listen({ port: process.env.PORT || 5000, host: '0.0.0.0' });
        console.log(`⚡ ZENEX Microservice V2 is LIVE at: http://localhost:${process.env.PORT || 5000}`);
    } catch (err) { process.exit(1); }
};
startServer();