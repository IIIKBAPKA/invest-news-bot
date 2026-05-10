const FMP_TOKEN = process.env.FMP_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const formatMoney = (num) => {
    if (!num) return 'Невідомо';
    if (num >= 1000000) return `$${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `$${(num / 1000).toFixed(0)}k`;
    return `$${num.toFixed(0)}`;
};

async function getInsiderBuys() {
    console.log("🕵️ Завантажуємо покупки інсайдерів (Ліміт: 5000)...");
    // ЗБІЛЬШЕНО ЛІМІТ ДО 5000 (це покриє кілька тижнів)
    const url = `https://financialmodelingprep.com/api/v4/insider-trading?transactionType=P-Purchase&limit=5000&apikey=${FMP_TOKEN}`;
    const response = await fetch(url);
    const data = await response.json();
    
    let insiderData = {}; // Зберігаємо не просто тікери, а деталі угод
    
    if (Array.isArray(data)) {
        data.forEach(trade => {
            const tradeValue = trade.securitiesTransacted * trade.price;
            
            // Беремо тільки солідні угоди (від $100,000) і тільки від ТОП-менеджменту
            if (tradeValue >= 100000 && !trade.typeOfOwner.includes("10% owner")) {
                if (!insiderData[trade.symbol]) insiderData[trade.symbol] = [];
                
                insiderData[trade.symbol].push({
                    name: trade.reportingName,
                    title: trade.typeOfOwner, // CEO, CFO, Director
                    amount: tradeValue,
                    date: trade.transactionDate
                });
            }
        });
    }
    return insiderData;
}

async function getPoliticalBuys() {
    console.log("🏛 Завантажуємо покупки політиків (Сенат та Палата представників)...");
    
    // Отримуємо дані і з Сенату, і з Палати (Senate + House)
    const [senateRes, houseRes] = await Promise.all([
        fetch(`https://financialmodelingprep.com/api/v4/senate-trading?limit=500&apikey=${FMP_TOKEN}`),
        fetch(`https://financialmodelingprep.com/api/v4/senate-disclosure?limit=500&apikey=${FMP_TOKEN}`) // У FMP Палата часто йде іншим ендпоінтом або змішана
    ]);
    
    const senateData = await senateRes.json();
    let politicalData = {};
    
    if (Array.isArray(senateData)) {
        senateData.forEach(trade => {
            if (trade.type && trade.type.toLowerCase().includes('purchase')) {
                if (!politicalData[trade.symbol]) politicalData[trade.symbol] = [];
                
                politicalData[trade.symbol].push({
                    name: trade.representative || trade.firstName + ' ' + trade.lastName,
                    amount: trade.amount, // Політики звітують діапазонами, напр. "$15,001 - $50,000"
                    date: trade.transactionDate
                });
            }
        });
    }
    return politicalData;
}

async function runSniper() {
    console.log("🎯 Аналізуємо збіги...");
    
    try {
        const insiders = await getInsiderBuys();
        const politicians = await getPoliticalBuys();
        
        let foundMatches = false;
        let message = "🎯 <b>СНАЙПЕР: ЗЛИТТЯ ГРОШЕЙ</b> 🎯\n\n";
        
        // Шукаємо перетин: тікери, які є в обох списках
        for (const ticker in politicians) {
            if (insiders[ticker]) {
                foundMatches = true;
                message += `🔥 <b>${ticker}</b>\n`;
                
                // Хто купив з політиків
                message += `🏛 <b>Політики:</b>\n`;
                politicians[ticker].forEach(p => {
                    message += `└ ${p.name} | Сума: ${p.amount} | Дата: ${p.date}\n`;
                });
                
                // Хто купив з інсайдерів
                message += `👔 <b>Інсайдери (ТОП-менеджмент):</b>\n`;
                insiders[ticker].slice(0, 3).forEach(i => { // Показуємо макс 3 останніх
                    let shortTitle = i.title.length > 20 ? i.title.substring(0,20)+"..." : i.title;
                    message += `└ ${i.name} (${shortTitle}) | <b>${formatMoney(i.amount)}</b> | Дата: ${i.date}\n`;
                });
                
                message += `\n`;
            }
        }
        
        if (!foundMatches) {
            message += "🤷‍♂️ Сьогодні спільних покупок (Інсайдери + Політики) не знайдено.";
        } else {
            message += "💡 <i>Перевірте ці тікери у вашому сканері опціонів!</i>";
        }
        
        // Відправка
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
        
        console.log("✅ Детальний звіт снайпера відправлено!");

    } catch (error) {
        console.error("❌ Помилка:", error);
    }
}

runSniper();
