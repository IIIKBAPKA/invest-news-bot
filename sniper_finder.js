const FMP_TOKEN = process.env.FMP_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!FMP_TOKEN) {
    console.error("❌ Немає FMP_TOKEN!");
    process.exit(1);
}

// Функція для отримання інсайдерських покупок
async function getInsiderBuys() {
    console.log("🕵️ Завантажуємо останні покупки інсайдерів...");
    // Шукаємо тільки P-Purchase (Покупки на відкритому ринку)
    const url = `https://financialmodelingprep.com/api/v4/insider-trading?transactionType=P-Purchase&limit=1000&apikey=${FMP_TOKEN}`;
    const response = await fetch(url);
    const data = await response.json();
    
    let insiderTickers = new Set();
    if (Array.isArray(data)) {
        data.forEach(trade => {
            // Фільтруємо дрібні покупки, беремо тільки від $50,000
            const tradeValue = trade.securitiesTransacted * trade.price;
            if (tradeValue >= 50000) {
                insiderTickers.add(trade.symbol);
            }
        });
    }
    return insiderTickers;
}

// Функція для отримання покупок політиків
async function getPoliticalBuys() {
    console.log("🏛 Завантажуємо останні покупки Сенату та Конгресу...");
    // FMP має два ендпоінти для політиків, візьмемо Сенат
    const url = `https://financialmodelingprep.com/api/v4/senate-trading?apikey=${FMP_TOKEN}`;
    const response = await fetch(url);
    const data = await response.json();
    
    let politicalTickers = new Set();
    if (Array.isArray(data)) {
        data.forEach(trade => {
            // Беремо тільки покупки (Purchase)
            if (trade.type && trade.type.toLowerCase().includes('purchase')) {
                politicalTickers.add(trade.symbol);
            }
        });
    }
    return politicalTickers;
}

async function runSniper() {
    console.log("🎯 Запуск радару 'Вашингтонський Снайпер'...");
    
    try {
        const insiderBuys = await getInsiderBuys();
        const politicalBuys = await getPoliticalBuys();
        
        // ЗНАХОДИМО ПЕРЕТИН (Злиття розумних грошей)
        let sniperTargets = [];
        for (let ticker of politicalBuys) {
            if (insiderBuys.has(ticker)) {
                sniperTargets.push(ticker);
            }
        }
        
        let message = "🎯 <b>РАДАР ВАШИНГТОНСЬКОГО СНАЙПЕРА</b> 🎯\n\n";
        message += "Знайдено збіги: <i>Інсайдери + Сенатори одночасно купують ці акції!</i>\n\n";
        
        if (sniperTargets.length > 0) {
            sniperTargets.forEach(ticker => {
                message += `🔥 <b>${ticker}</b> - <a href="https://finviz.com/quote.ashx?t=${ticker}">Графік Finviz</a> | <a href="https://finance.yahoo.com/quote/${ticker}/options">Опціони</a>\n`;
            });
            message += "\n💡 <i>Порада: Додайте ці тікери у ваш сканер опціонів!</i>";
        } else {
            message += "🤷‍♂️ Сьогодні збігів не знайдено. Чекаємо на китів.";
        }
        
        // Відправка в Телеграм
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                chat_id: TELEGRAM_CHAT_ID, 
                text: message, 
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });
        
        console.log("✅ Звіт снайпера відправлено!");

    } catch (error) {
        console.error("❌ Помилка роботи снайпера:", error);
    }
}

runSniper();
