console.log("🚀 Запуск 'Вашингтонського Снайпера' (Глобальне сканування ринку)...");

const FMP_TOKEN = (process.env.FMP_TOKEN || "").trim();
const TELEGRAM_TOKEN = (process.env.TELEGRAM_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();

if (!FMP_TOKEN) {
    console.error("❌ ПОМИЛКА: Не знайдено FMP_TOKEN!");
    process.exit(1);
}

const formatMoney = (num) => {
    if (!num) return 'Невідомо';
    if (num >= 1000000) return `$${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `$${(num / 1000).toFixed(0)}k`;
    return `$${num.toFixed(0)}`;
};

// 1. Отримуємо дані Сенату з відкритого джерела (Без лімітів)
async function getSenateMarketWide() {
    console.log("🏛 Завантажуємо глобальну базу Сенату (Open Source)...");
    try {
        const res = await fetch("https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json");
        const data = await res.json();
        
        let recentBuys = {};
        const sixtyDaysAgo = new Date();
        sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60); // Беремо покупки за останні 60 днів

        data.forEach(trade => {
            if (trade.type && trade.type.toLowerCase().includes('purchase') && trade.ticker && trade.ticker !== "N/A") {
                const tradeDate = new Date(trade.transaction_date);
                if (tradeDate >= sixtyDaysAgo) {
                    const cleanTicker = trade.ticker.replace(/<[^>]*>?/gm, '').trim(); // Чистимо від можливого HTML
                    if (!recentBuys[cleanTicker]) recentBuys[cleanTicker] = [];
                    
                    recentBuys[cleanTicker].push({
                        name: trade.senator || trade.representative || "Сенатор",
                        amount: trade.amount,
                        date: trade.transaction_date
                    });
                }
            }
        });
        return recentBuys;
    } catch (err) {
        console.error("❌ Помилка завантаження бази Сенату:", err.message);
        return {};
    }
}

// 2. Точкова перевірка інсайдерів через FMP
async function checkInsiderTarget(ticker) {
    try {
        const res = await fetch(`https://financialmodelingprep.com/stable/insider-trading?symbol=${ticker}&transactionType=P-Purchase&limit=100&apikey=${FMP_TOKEN}`);
        const data = await res.json();
        
        let insiders = [];
        if (Array.isArray(data)) {
            data.forEach(trade => {
                const tradeValue = trade.securitiesTransacted * trade.price;
                // Фільтр: від $100k, виключаємо фонди
                if (tradeValue >= 100000 && !trade.typeOfOwner.includes("10% owner")) {
                    insiders.push({
                        name: trade.reportingName,
                        title: trade.typeOfOwner,
                        amount: tradeValue,
                        date: trade.transactionDate
                    });
                }
            });
        }
        return insiders;
    } catch (err) {
        return [];
    }
}

async function runGlobalSniper() {
    try {
        // КРОК 1: Збираємо всі політичні покупки по всьому ринку
        const politicalBuys = await getSenateMarketWide();
        const globalTickers = Object.keys(politicalBuys);
        
        console.log(`\n📊 РЕЗУЛЬТАТ СИТА:`);
        console.log(`🏛 Знайдено компаній, які купували політики за ост. 60 днів: ${globalTickers.length}`);
        if (globalTickers.length > 0) console.log(`👉 Перевіряємо інсайдерів для: ${globalTickers.join(', ')}`);
        console.log(`-------------------------\n`);

        if (globalTickers.length === 0) {
            console.log("Немає політичних покупок для перевірки. Завершуємо.");
            return;
        }

        let message = "🎯 <b>СНАЙПЕР: ГЛОБАЛЬНЕ ЗЛИТТЯ ГРОШЕЙ</b> 🎯\n\n";
        let foundMatches = false;

        // КРОК 2: Перевіряємо кожен знайдений тікер на наявність інсайдерів
        for (const ticker of globalTickers) {
            // Фільтруємо сміттєві тікери
            if (ticker.length > 5 || ticker.includes(' ')) continue; 

            const insiders = await checkInsiderTarget(ticker);
            
            if (insiders.length > 0) {
                foundMatches = true;
                console.log(`🔥 Знайдено глобальний збіг для ${ticker}!`);
                
                message += `🔥 <b>${ticker}</b>\n`;
                
                message += `🏛 <b>Політики:</b>\n`;
                politicalBuys[ticker].slice(0, 3).forEach(p => {
                    message += `└ ${p.name} | Сума: ${p.amount} | Дата: ${p.date}\n`;
                });
                
                message += `👔 <b>Інсайдери (ТОП-менеджмент):</b>\n`;
                insiders.slice(0, 3).forEach(i => { 
                    let shortTitle = i.title.length > 20 ? i.title.substring(0,20)+"..." : i.title;
                    message += `└ ${i.name} (${shortTitle}) | <b>${formatMoney(i.amount)}</b> | Дата: ${i.date}\n`;
                });
                message += `\n`;
            }
            
            // Захист від rate-limit API FMP (пауза 300мс)
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        if (!foundMatches) {
            message += "🤷‍♂️ Сьогодні спільних покупок (Інсайдери + Політики) на всьому ринку не знайдено.";
            console.log("РЕЗУЛЬТАТ: Збігів немає.");
        } else {
            message += "💡 <i>Ці акції знайдені шляхом повного сканування ринку.</i>";
        }

        // Відправка в ТГ
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
            console.log("✅ Глобальний звіт відправлено в Telegram!");
        } else {
            console.error("❌ Telegram відхилив повідомлення:", await tgResponse.text());
        }

    } catch (error) {
        console.error("❌ Критична помилка у головній функції:", error);
    }
}

runGlobalSniper();
