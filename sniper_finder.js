console.log("🚀 Скрипт успішно стартував! Ініціалізація...");

const FMP_TOKEN = (process.env.FMP_TOKEN || "").trim();
const TELEGRAM_TOKEN = (process.env.TELEGRAM_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();

if (!FMP_TOKEN) {
    console.error("❌ ПОМИЛКА: Не знайдено FMP_TOKEN у секретах GitHub!");
    process.exit(1);
} else {
    console.log(`🔑 FMP Токен знайдено (Довжина: ${FMP_TOKEN.length} симв.)`);
}

const formatMoney = (num) => {
    if (!num) return 'Невідомо';
    if (num >= 1000000) return `$${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `$${(num / 1000).toFixed(0)}k`;
    return `$${num.toFixed(0)}`;
};

async function getInsiderBuys() {
    console.log("🕵️ Завантажуємо покупки інсайдерів (Ліміт: 5000)...");
    const url = `https://financialmodelingprep.com/api/v4/insider-trading?transactionType=P-Purchase&limit=5000&apikey=${FMP_TOKEN}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        let insiderData = {}; 
        
        if (Array.isArray(data)) {
            data.forEach(trade => {
                const tradeValue = trade.securitiesTransacted * trade.price;
                
                // Беремо тільки солідні угоди (від $100,000) і відсікаємо фонди
                if (tradeValue >= 100000 && !trade.typeOfOwner.includes("10% owner")) {
                    if (!insiderData[trade.symbol]) insiderData[trade.symbol] = [];
                    
                    insiderData[trade.symbol].push({
                        name: trade.reportingName,
                        title: trade.typeOfOwner, 
                        amount: tradeValue,
                        date: trade.transactionDate
                    });
                }
            });
        } else {
            console.error("⚠️ Відповідь API інсайдерів не є масивом. Можливо помилка токена:", data);
        }
        return insiderData;
    } catch (err) {
        console.error("❌ Помилка fetch інсайдерів:", err);
        return {};
    }
}

async function getPoliticalBuys() {
    console.log("🏛 Завантажуємо покупки політиків (Сенат та Палата представників)...");
    
    try {
        const [senateRes, houseRes] = await Promise.all([
            fetch(`https://financialmodelingprep.com/api/v4/senate-trading?limit=500&apikey=${FMP_TOKEN}`),
            fetch(`https://financialmodelingprep.com/api/v4/senate-disclosure?limit=500&apikey=${FMP_TOKEN}`) 
        ]);
        
        const senateData = await senateRes.json();
        const houseData = await houseRes.json();
        
        let politicalData = {};
        
        const processPoliticalData = (dataArray) => {
            if (Array.isArray(dataArray)) {
                dataArray.forEach(trade => {
                    if (trade.type && trade.type.toLowerCase().includes('purchase')) {
                        if (!politicalData[trade.symbol]) politicalData[trade.symbol] = [];
                        
                        politicalData[trade.symbol].push({
                            name: trade.representative || trade.firstName + ' ' + trade.lastName,
                            amount: trade.amount,
                            date: trade.transactionDate
                        });
                    }
                });
            }
        };

        processPoliticalData(senateData);
        processPoliticalData(houseData);
        
        return politicalData;
    } catch (err) {
         console.error("❌ Помилка fetch політиків:", err);
         return {};
    }
}

async function runSniper() {
    console.log("🎯 Аналізуємо бази даних...");
    
    try {
        const insiders = await getInsiderBuys();
        const politicians = await getPoliticalBuys();
        
        // --- ДЕБАГ БЛОК ---
        const insiderTickers = Object.keys(insiders);
        const polTickers = Object.keys(politicians);
        console.log(`\n📊 ДЕБАГ СТАТИСТИКА:`);
        console.log(`👔 Унікальних компаній, де купували інсайдери: ${insiderTickers.length}`);
        if (insiderTickers.length > 0) console.log(`👉 Приклади: ${insiderTickers.slice(0, 5).join(', ')}...`);
        console.log(`🏛 Унікальних компаній, де купували політики: ${polTickers.length}`);
        if (polTickers.length > 0) console.log(`👉 Приклади: ${polTickers.slice(0, 5).join(', ')}...`);
        console.log(`-------------------------\n`);
        
        let foundMatches = false;
        let message = "🎯 <b>СНАЙПЕР: ЗЛИТТЯ ГРОШЕЙ</b> 🎯\n\n";
        
        for (const ticker in politicians) {
            if (insiders[ticker]) {
                foundMatches = true;
                message += `🔥 <b>${ticker}</b>\n`;
                
                message += `🏛 <b>Політики:</b>\n`;
                politicians[ticker].forEach(p => {
                    message += `└ ${p.name} | Сума: ${p.amount} | Дата: ${p.date}\n`;
                });
                
                message += `👔 <b>Інсайдери (ТОП-менеджмент):</b>\n`;
                insiders[ticker].slice(0, 3).forEach(i => { 
                    let shortTitle = i.title.length > 20 ? i.title.substring(0,20)+"..." : i.title;
                    message += `└ ${i.name} (${shortTitle}) | <b>${formatMoney(i.amount)}</b> | Дата: ${i.date}\n`;
                });
                
                message += `\n`;
            }
        }
        
        if (!foundMatches) {
            message += "🤷‍♂️ Сьогодні спільних покупок (Інсайдери + Політики) не знайдено.";
            console.log("РЕЗУЛЬТАТ: Збігів немає.");
        } else {
            message += "💡 <i>Перевірте ці тікери у вашому сканері опціонів!</i>";
            console.log("РЕЗУЛЬТАТ: Знайдено збіги!");
        }
        
        const tgResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                chat_id: TELEGRAM_CHAT_ID, 
                text: message, 
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });
        
        if (tgResponse.ok) {
            console.log("✅ Детальний звіт снайпера відправлено в Telegram!");
        } else {
            const errTg = await tgResponse.text();
            console.error("❌ Telegram відхилив повідомлення:", errTg);
        }

    } catch (error) {
        console.error("❌ Критична помилка у головній функції:", error);
    }
}

runSniper();
