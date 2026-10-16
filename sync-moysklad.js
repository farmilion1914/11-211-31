const admin = require('firebase-admin');
const https = require('https');
const zlib = require('zlib');

// ============ НАСТРОЙКИ ============
const MOYSKLAD_TOKEN = '48ec8cffb443b486cf03b3e9a9922dcf88ce5673';
const BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';

// ID складов
const STORES = {
    'ВБ': 'e3940ed7-f90e-11ec-0a80-01d000062667',
    'ОЗОН': 'd4ee3880-561d-11ef-0a80-1570000743cb',
    'ПУШКИНО': '9519dfcf-13be-11f1-0a80-103d000a5c19',
    'Сырье': 'cced55d7-08f1-11ed-0a80-0c2a0022fb1e'
};

// Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

// ============ FIREBASE ============
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ============ ЗАПРОС К API ============
function fetchUrl(url, token) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json;charset=utf-8',
                'Accept-Encoding': 'gzip',
                'User-Agent': 'GQbox/1.0'
            }
        };
        https.get(url, options, (res) => {
            let chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                let buffer = Buffer.concat(chunks);
                const encoding = res.headers['content-encoding'];
                
                if (encoding === 'gzip') {
                    zlib.gunzip(buffer, (err, decoded) => {
                        if (err) {
                            reject(new Error('Ошибка распаковки gzip'));
                            return;
                        }
                        processResponse(decoded.toString());
                    });
                } else {
                    processResponse(buffer.toString());
                }
                
                function processResponse(data) {
                    if (res.statusCode !== 200) {
                        console.log(`  Статус: ${res.statusCode}`);
                        console.log(`  Ответ: ${data.slice(0, 300)}`);
                        reject(new Error(`Ошибка API: ${res.statusCode}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch(e) {
                        reject(new Error('Ответ не JSON'));
                    }
                }
            });
        }).on('error', reject);
    });
}

// ============ ПОЛУЧЕНИЕ ОСТАТКОВ ПО СКЛАДУ ============
async function getStockByWarehouse(storeId, storeName) {
    const url = `${BASE_URL}/report/stock/all?filter=store=https://api.moysklad.ru/api/remap/1.2/entity/store/${storeId}&limit=1000`;
    console.log(`  Запрос: ${storeName}...`);
    
    let allRows = [];
    let offset = 0;
    let hasMore = true;
    
    while (hasMore) {
        const pageUrl = `${url}&offset=${offset}`;
        const data = await fetchUrl(pageUrl, MOYSKLAD_TOKEN);
        
        if (data.rows && data.rows.length > 0) {
            allRows = allRows.concat(data.rows);
            offset += data.rows.length;
            hasMore = data.rows.length === 1000;
        } else {
            hasMore = false;
        }
    }
    
    if (allRows.length === 0) {
        console.log(`  Нет данных для склада ${storeName}`);
        return [];
    }
    
    return allRows.map(row => ({
        article: row.article || '',
        name: row.name || '',
        balance: row.stock || 0,
        waiting: row.inTransit || 0,
        warehouse: storeName
    }));
}

// ============ СУММИРОВАНИЕ ============
function mergeStocks(allStocks) {
    const merged = {};
    allStocks.forEach(item => {
        const key = item.article || item.name;
        if (!merged[key]) {
            merged[key] = { ...item, balance: 0, waiting: 0 };
        }
        merged[key].balance += item.balance;
        merged[key].waiting += item.waiting;
    });
    return Object.values(merged);
}

// ============ СОХРАНЕНИЕ ============
async function saveToFirestore(collectionName, items) {
    await db.collection('settings').doc(collectionName).set({
        items: items,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`  ✅ ${collectionName}: ${items.length} позиций`);
}

// ============ ГЛАВНАЯ ============
async function syncAll() {
    console.log(`🔄 Синхронизация: ${new Date().toLocaleString('ru-RU')}`);
    
    try {
        const stockVB = await getStockByWarehouse(STORES['ВБ'], 'ВБ');
        console.log(`  ВБ: ${stockVB.length} поз.`);
        
        const stockOZON = await getStockByWarehouse(STORES['ОЗОН'], 'ОЗОН');
        console.log(`  ОЗОН: ${stockOZON.length} поз.`);
        
        const stockPushkino = await getStockByWarehouse(STORES['ПУШКИНО'], 'ПУШКИНО');
        console.log(`  ПУШКИНО: ${stockPushkino.length} поз.`);
        
        const stockSyrie = await getStockByWarehouse(STORES['Сырье'], 'Сырье');
        console.log(`  Сырье: ${stockSyrie.length} поз.`);

        await saveToFirestore('wbStock', stockVB);
        await saveToFirestore('ozonStock', stockOZON);

        const allStocks = [...stockVB, ...stockOZON, ...stockPushkino, ...stockSyrie];
        const mergedMS = mergeStocks(allStocks);
        await saveToFirestore('msStock', mergedMS);

        console.log('✅ Синхронизация завершена');
        
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        process.exit(1);
    }
}

syncAll();
