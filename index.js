const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const UA = require('user-agents');
const cloudscraper = require('cloudscraper');
const https = require('https');

// const { createRequire } = require('module');
// const createdRequire = createRequire(import.meta.url);
// const { fetch } = require('node-fetch');

// Set up the proxy configuration
const agent = new https.Agent({
    rejectUnauthorized: false,  // Allow self-signed certificates if needed
});


function getProxyAgent(proxy) {
    if (proxy.startsWith('socks4://') || proxy.startsWith('socks5://')) {
        return new SocksProxyAgent(proxy);
    } else if (proxy.startsWith('http://')) {
        return new HttpProxyAgent(proxy);
    } else if (proxy.startsWith('https://')) {
        return new HttpsProxyAgent(proxy);
    } else {
        throw new Error(`Unsupported proxy type for proxy: ${proxy}`);
    }
}

function getProxyOptions(proxy) {
    // console.log(`options ${proxy}`);
    if (proxy.startsWith('socks4') || proxy.startsWith('socks5')) {
        return { agent: new SocksProxyAgent(proxy) };  // Return SocksProxyAgent for socks proxies
    } else {
        return { proxy };  // Use direct proxy setting for http/https
    }
}

// Function to load and randomly pick a proxy source
async function loadProxiesFromSource(proxySourceFile) {
    const sources = fs.readFileSync(proxySourceFile, 'utf8').split('\n').map(line => line.trim()).filter(line => line);
    if (sources.length === 0) {
        throw new Error('No proxy sources found in proxy_source.txt.');
    }

    // Pick a random source
    const randomSource = sources[Math.floor(Math.random() * sources.length)];
    const [sourceUrl, protocol] = randomSource.split(',');

    try {
        const response = await axios.get(sourceUrl);
        const proxies = response.data.split('\n').map(proxy => `${protocol || ''}${proxy.trim()}`).filter(proxy => proxy);
        if (proxies.length === 0) {
            throw new Error(`No proxies fetched from ${sourceUrl}`);
        }
        return proxies;
    } catch (error) {
        console.error(`Failed to fetch proxies from ${sourceUrl}:`, error.message);
        return [];
    }
}

// Function to get UID using a token
async function getUid(token) {
    const url = 'https://api.aigaea.net/api/auth/session';
    try {
        const response = await axios.post(url, {}, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Origin: 'http://app.aigaea.net',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36'
            }
        });
        return response.data.data?.uid || null;
    } catch (error) {
        console.error(`Failed to get UID: ${error.message}`);
        return null;
    }
}

// Function to connect to API using a proxy
async function connectToHttp(uid, token, proxy, deviceId) {
    // const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.floor(Math.random() * 100 + 50)}.0 Safari/537.36`;
    // const agent = getProxyAgent(proxy);
    const userAgent = new UA({ deviceCategory: 'desktop' }).random().toString();

    const headers = {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": userAgent,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": "https://api.aigaea.net"
    };

    const url = 'https://api.aigaea.net/api/network/ping';

    const data = {
        uid,
        browser_id: deviceId,
        timestamp: Math.floor(Date.now() / 1000),
        version: '1.0.0'
    };

    const options = {
        method: 'POST',
        uri: url,
        body: JSON.stringify(data),
        headers,
        timeout: 30000,
        proxy: `${proxy}`,
        agent: agent
    };


    try {
        // const response = await cloudscraper.post({
        //     uri: url,
        //     headers,
        //     body: JSON.stringify(data),
        //     timeout: 30000,
        //     json: true,
        //     proxy: `${proxy}`,
        //     agent: agent            
        // });
        const response = await axios.post(url, data, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': userAgent,
            },
            httpsAgent: getProxyAgent(proxy),
            timeout: 30000,  // 30 seconds timeout for the request
            proxy: false,             
        });

        if (response) {
            // const responseData = await response.json();
            console.log(`Response: ${response}`);
        } else {
            console.error(`Request failed with status: ${response.status}`);
        }
    } catch (error) {
        console.error(`Error using proxy ${proxy}: ${error.message}`);
    }
}

// Function to run all proxies concurrently
async function runAllProxies(uid, token, proxies, browserId) {
    const tasks = [];
    const rdm = uuidv4().slice(8);  // Generate random segment for device ID
    const deviceId = `${browserId}${rdm}`;

    for (const proxy of proxies) {
        tasks.push(connectToHttp(uid, token, proxy, deviceId));
    }
    await Promise.all(tasks);
}

// Function to loop through proxies continuously
async function loopProxies(uid, token, proxySourceFile, delays, browserId, loopCount = null) {
    let count = 0;
    while (true) {
        console.log(`Starting loop ${count + 1}...`);

        const proxies = await loadProxiesFromSource(proxySourceFile);
        if (proxies.length === 0) {
            console.error('No proxies available, skipping this loop.');
            await new Promise(resolve => setTimeout(resolve, delays * 1000));
            continue;
        }

        await runAllProxies(uid, token, proxies, browserId);

        console.log(`Cycle ${count + 1} completed. Waiting ${delays} seconds before next cycle...`);
        await new Promise(resolve => setTimeout(resolve, delays * 1000));

        count++;
        if (loopCount && count >= loopCount) {
            console.log(`Completed ${loopCount} loops. Exiting.`);
            break;
        }
    }
}

// Main function to handle multiple users
async function main() {
    try {
        const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
        const proxySourceFile = 'proxy_sources.txt';

        const tasks = config.data.map(async user => {
            const { token, browserId, delays } = user;
            const uid = await getUid(token);

            if (!uid) {
                console.error(`Failed to retrieve UID for token ${token}. Skipping user.`);
                return;
            }

            await loopProxies(uid, token, proxySourceFile, delays, browserId);
        });

        await Promise.all(tasks);
    } catch (error) {
        console.error('Error:', error.message);
    }
}

main();
