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
    allowedHeaders: ['Content-Type', 'mapikey', 'x-dashboard-user', 'User-Agent']
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

// ==========================================
// 💥 GLOBAL SDE CACHE & FETCHER 💥
// ==========================================
const globalSdeMap = new Map();

const fetchSdeList = async () => {
    try {
        const payload = { jsonrpc: "2.0", method: "sms.realtime:get_subdestination_list", params: {}, id: Date.now() };
        const res = await fetch(IPRN_API_URL, {
            method: "POST",
            headers: { "Api-Key": IPRN_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (data?.result?.subdestination_list) {
            data.result.subdestination_list.forEach(item => {
                globalSdeMap.set(item.sde_key, item.name);
            });
            console.log(`✅ Official SDE Dictionary Loaded: ${globalSdeMap.size} destinations cached.`);
        }
    } catch (e) {
        console.error("⚠️ Failed to load SDE list:", e.message);
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

const extractStrictOTP = (rawText) => {
    if (!rawText) return "00000";
    const match = rawText.match(/(?:\b\d{4,8}\b)|(?:\b\d{3}[\s-]\d{3,4}\b)/);
    return match ? match[0].trim() : "00000";
};

const escapeRegExp = (string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const applyMasking = (text, keywords) => {
    if (!text) return text;
    let masked = text;
    keywords.forEach(w => {
        const word = w.trim();
        if (word && word.length > 1) {
            const regex = new RegExp(escapeRegExp(word), 'gi');
            masked = masked.replace(regex, (match) => {
                return match.replace(/[^\s]/g, '*');
            });
        }
    });
    return masked;
};

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of apiAuthCache.entries()) {
        if (now > value.expiry) apiAuthCache.delete(key);
    }
    for (const [key, value] of userOtpResponseCache.entries()) {
        if (now > value.expiry) userOtpResponseCache.delete(key);
    }
}, 30000); 

setInterval(() => { globalWorkerUserCache.clear(); }, 5 * 60 * 1000); 

async function triggerBinanceAutoPay(user) {
    try {
        const res = await fetch(`${process.env.MAIN_SITE_URL}/api/cron/process-binance-payout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user._id })
        });
        const result = await res.json().catch(() => ({}));
        if (result && result.success === false) {
            await User.findOneAndUpdate({ _id: user._id }, { $set: { autoPayEnabled: false } });
            if (globalWorkerUserCache.has(user.email)) {
                let cachedUser = globalWorkerUserCache.get(user.email);
                cachedUser.autoPayEnabled = false;
                globalWorkerUserCache.set(user.email, cachedUser);
            }
        }
    } catch (e) {}
}

fastify.route({
    method: ['GET', 'POST'], 
    url: '/v1/getnum',
    handler: async (request, reply) => {
        try {
            const apiKey = request.headers['mapikey'] || (request.query && request.query.mapikey);
            if (!apiKey || apiKey.trim().length < 10) return reply.status(401).send({ meta: { status: "error" }, message: "Invalid API Key" });

            const cleanKey = apiKey.trim();
            let user;

            // 💥 BOSS INSTRUCTION STRICT FIX: Absolute Data Integrity Check 💥
            if (cleanKey === "ZENEX_INTERNAL_DASHBOARD_PASS") {
                const dashEmail = request.headers['x-dashboard-user'];
                if (!dashEmail) return reply.status(403).send({ meta: { status: "error" }, message: "Unauthorized Dashboard Request. Headers Stripped." });
                
                // No Fallbacks. Must find exact user in DB.
                user = await User.findOne({ email: dashEmail }).lean();
                if (!user) return reply.status(403).send({ meta: { status: "error" }, message: "Critical: User Data Missing in Database. Aborting transaction." });
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
                // 💥 1-STEP REALTIME ALLOCATION 💥
                const payload = {
                    jsonrpc: "2.0",
                    method: "sms.realtime:allocate",
                    params: { 
                        senderid: "OTP", 
                        prefix_list: [String(rawRange).toUpperCase().replace(/X/g, '')], 
                        dont_check_access: true
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

            // 💥 INSTANT NUMBER EXTRACTION 💥
            if (data.result && data.result.number && data.result.number.full) {
                const trxId = data.result.message_id || "";
                const fullNumStr = String(data.result.number.full || "");
                const localNumStr = String(data.result.number.local_number || fullNumStr);
                
                // 💥 ADVANCED SDE PARSER 💥
                let exactCountry = "Unknown";
                let exactOperator = "Mobile"; 

                if (data.result.sde_key && globalSdeMap.has(data.result.sde_key)) {
                    let rawName = globalSdeMap.get(data.result.sde_key);
                    rawName = rawName.replace(/\s*\([\d+X]+\)\s*$/g, '').trim();
                    const parts = rawName.split(' - ');
                    exactCountry = parts[0] ? parts[0].trim() : "Unknown";
                    if (parts.length >= 3) {
                        exactOperator = parts[2].trim(); 
                    } else if (parts.length === 2) {
                        exactOperator = parts[1].trim().toLowerCase() === "mobile" ? "Mobile" : parts[1].trim();
                    }
                }
                
                clearTimeout(timeoutId);
                const todayStr = getUTCDateString();
                
                // 💥 DB SAVE WITH 100% SECURE VERIFIED SCHEMA 💥
                let generatedOrderId = null;
                try {
                    const matchedName = user.fullName || user.email.split("@")[0];
                    const matchedUid = user.uid || user.zxId || (user._id ? `ZX-${user._id.toString().slice(-6).toUpperCase()}` : "ZX-UNKNOWN");
                    const matchedAgent = (user.agentEmail || user.customAgentMail || "admin").toLowerCase(); 

                    const newOrder = new Order({
                        userEmail: user.email,
                        userName: matchedName,         
                        userUid: matchedUid,           
                        agentEmail: matchedAgent,      
                        searchNumber: fullNumStr,
                        requestedRange: rawRange, 
                        trxId: String(trxId), 
                        displayNumber: `+${fullNumStr}`,
                        country: exactCountry,
                        operator: exactOperator,
                        status: "WAIT",
                        fullMessage: "Waiting...",
                        otp: "Waiting...", 
                        trueService: "Unknown", 
                        dateString: todayStr,
                        expireAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
                    });
                    const savedOrder = await newOrder.save();
                    generatedOrderId = savedOrder._id.toString(); 
                } catch (dbErr) {
                    console.error("⚠️ Local DB Save Error:", dbErr.message);
                }
                
                console.log(`🚀 [SUCCESS] Number: +${fullNumStr} | Country: ${exactCountry} | Operator: ${exactOperator}`);

                return reply.status(200).send({
                    success: true,
                    meta: { status: "ok", code: 200 },
                    data: {
                        copy: `+${fullNumStr}`,
                        number: `+${fullNumStr}`,
                        full_number: `+${fullNumStr}`,         
                        national_number: localNumStr,          
                        no_plus_number: fullNumStr,            
                        country: exactCountry,
                        operator: exactOperator
                    },
                    orderId: generatedOrderId,
                    message: "number allocated"
                });
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
        const recentOrders = await Order.find({ status: { $in: ["DONE", "Success", "SUCCESS"] }, updatedAt: { $gte: oneHourAgo } }).select("fullMessage otp searchNumber number trueService").lean();
        const rangeMap = {};

        recentOrders.forEach((o) => {
            let msg = o.fullMessage || o.otp || "";
            const rawService = o.trueService || "Unknown";
            const maskedService = applyMasking(rawService, hiddenKeywords); 

            let num = o.searchNumber || o.number || "";
            num = String(num).replace("+", "");
            
            if (num.length >= 6) {
                const rangeStr = num.substring(0, 6) + "XXX"; 
                let tag = "General";
                if (rawService.toLowerCase() === "facebook" || rawService.toLowerCase() === "meta") {
                    const match = msg.match(/\b\d{4,8}\b/);
                    if (match) {
                        if (match[0].length === 6 || match[0].length === 8) tag = "Fb Clone";
                        else if (match[0].length === 5) tag = "New Fb";
                    }
                }
                
                const maskedTag = applyMasking(tag, hiddenKeywords); 

                const key = `${rangeStr}|${maskedService}|${maskedTag}`;
                if (!rangeMap[key]) rangeMap[key] = { range: rangeStr, service: maskedService, tag: maskedTag, hits: 0 };
                rangeMap[key].hits += 1;
            }
        });

        const formattedRanges = Object.values(rangeMap).sort((a, b) => b.hits - a.hits).slice(0, 10);
        cachedActiveData = { active_ranges: formattedRanges };
        lastFetchTime = Date.now();

        return reply.send({ success: true, cached: false, data: cachedActiveData });
    } catch (error) { return reply.status(500).send({ success: false, message: "Server Error" }); }
});

fastify.get('/v1/user/today-otps', async (request, reply) => {
    try {
        const apiKey = request.headers['mapikey'];
        if (!apiKey) return reply.status(401).send({ error: "Invalid API Key" });
        const cleanKey = apiKey.trim();
        
        let cachedObj = apiAuthCache.get(cleanKey);
        let user;

        if (!cachedObj || Date.now() > cachedObj.expiry) {
            user = await User.findOne({ apiKey: cleanKey }).select("email").lean();
        } else {
            user = cachedObj.user;
        }
        
        if (!user) return reply.status(401).send({ error: "Invalid API Key" });

        const hiddenKeywords = await getMaskingKeywords();
        const todayStr = getUTCDateString();
        const orders = await Order.find({ userEmail: user.email, dateString: todayStr, status: "DONE" }).select("displayNumber otp fullMessage -_id").lean();
        if (orders.length === 0) return reply.type('text/plain').send("NO_DATA");
        
        const textData = orders.map((o) => {
            return `${String(o.displayNumber).replace(/\D/g, "")}|${applyMasking(o.fullMessage || o.otp || "", hiddenKeywords)}`;
        }).join('\n');
        
        return reply.type('text/plain').send(textData);
    } catch (error) { return reply.status(500).send({ error: "Server Error" }); }
});

const processIncomingOTP = async (trunkTxId, text, senderId, destNum) => {
    if (!text) return;
    const query = trunkTxId ? { trxId: String(trunkTxId) } : { searchNumber: String(destNum).replace('+', '') };
    const existingOrders = await Order.find(query).sort({ _id: 1 });
    
    if (existingOrders.length > 0) {
        const baseOrder = existingOrders[0];
        const orderAgeInMs = Date.now() - new Date(baseOrder.createdAt).getTime();
        const maxAllowedTime = 25 * 60 * 1000; 
        if (orderAgeInMs > maxAllowedTime || baseOrder.status === "FAIL" || baseOrder.status === "CANCEL") return; 

        const strictOtp = extractStrictOTP(text);
        const isDuplicate = existingOrders.some(o => 
            o.fullMessage === text || 
            (o.fullMessage && o.fullMessage.includes(text)) || 
            o.otp === strictOtp
        );
        
        if (!isDuplicate) {
            if (baseOrder.status === "WAIT") {
                baseOrder.status = "DONE";
                baseOrder.otp = strictOtp;
                baseOrder.fullMessage = text;
                baseOrder.trueService = senderId || "Unknown";
                await baseOrder.save();
            } else {
                const newMultiOrder = new Order({
                    userEmail: baseOrder.userEmail,
                    userName: baseOrder.userName,
                    userUid: baseOrder.userUid,
                    agentEmail: baseOrder.agentEmail,
                    searchNumber: baseOrder.searchNumber,
                    displayNumber: baseOrder.displayNumber,
                    country: baseOrder.country,
                    operator: baseOrder.operator,
                    dateString: baseOrder.dateString,
                    orderCost: baseOrder.orderCost,
                    orderCommission: baseOrder.orderCommission,
                    requestedRange: baseOrder.requestedRange,
                    trxId: baseOrder.trxId,
                    status: "DONE",
                    otp: strictOtp,
                    fullMessage: text,
                    trueService: senderId || "Unknown",
                    expireAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
                });
                await newMultiOrder.save();
            }
        }
    }
};

fastify.post('/v1/webhook/iprn-receive', async (request, reply) => {
    try {
        const allowedIPs = ['51.38.107.49', '127.0.0.1']; 
        const clientIP = request.ip;
        
        if (!allowedIPs.includes(clientIP)) {
            console.warn(`🚨 Security Breach Blocked: Unauthorized Webhook attempt from IP: ${clientIP}`);
            return reply.status(403).send({ success: false, message: "Unauthorized IP. ZENEX Security Firewall Active." });
        }

        const data = request.body || {};
        const trunkTxId = data.message_id || data.trunk_number_transaction_id || data.trxId;
        const text = data.text || data.message || data.content;
        const senderId = data.senderid || data.source_addr || "Unknown";
        const destNum = data.destination_addr || data.number;

        if (!text) return reply.status(400).send({ success: false, message: "No text found in payload" });

        await processIncomingOTP(trunkTxId, text, senderId, destNum);

        return reply.status(200).send({ success: true, message: "Webhook received and processed" });
    } catch (error) {
        console.error("❌ Webhook Processing Error:", error.message);
        return reply.status(500).send({ success: false, message: "Internal Server Error" });
    }
});

let isPolling = false;
const pollIncomingOTPs = async () => {
    if (!IPRN_SMS_TRUNK_ID || isPolling) return;
    isPolling = true;
    try {
        const payload = {
            jsonrpc: "2.0",
            method: "sms.mdr_full:get_list",
            params: { target: { "sms.trunk_id": IPRN_SMS_TRUNK_ID }, limit: 40 },
            id: Date.now()
        };
        
        const res = await fetch(IPRN_API_URL, {
            method: "POST",
            headers: { "Api-Key": IPRN_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (data && data.result && Array.isArray(data.result.mdr_list)) {
            for (const msg of data.result.mdr_list) {
                const trunkTxId = msg.message_id || msg.trunk_number_transaction_id;
                const text = msg.text || msg.message || "";
                const senderId = msg.senderid || msg.source_addr || "Unknown";
                const destNum = msg.destination_addr || msg.number || "";
                
                await processIncomingOTP(trunkTxId, text, senderId, destNum);
            }
        }
    } catch (err) {} finally { isPolling = false; }
};

setInterval(pollIncomingOTPs, 5000);

const startServer = async () => {
    try {
        await connectDB();
        await fetchIPRNTrunk(); 
        await fetchSdeList(); 
        await fastify.listen({ port: process.env.PORT || 5000, host: '0.0.0.0' });
        console.log(`⚡ ZENEX Microservice V2 is LIVE at: http://localhost:${process.env.PORT || 5000}`);
    } catch (err) { process.exit(1); }
};
startServer();