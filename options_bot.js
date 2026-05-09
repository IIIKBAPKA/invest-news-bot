const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const TARGET_COMPANIES = [
    "NVDA", "GOOG", "VST", "AAPL", "TSLA", "DASH", "NEE", "UBER", 
    "CVX", "XOM", "ADBE", "AMZN", "KO", "MSFT", "NFLX", "META", 
    "AMD", "SPY", "QQQ"
];

const formatMoney = (num) => {
    if (num >= 1000000) return `$${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `$${(num / 1000).toFixed(0)}k`;
    return `$${num.toFixed(0)}`;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runOptionsScanner() {
    console.log("🔍 Запуск сканера опціонів (джерело: MarketData API)...");
    
    let finalTelegramMessage = "🐋 <b>РАДАР АНОМАЛЬНИХ ОПЦІОНІВ</b> 🐋\n\n";
    let foundAnomalies = false;

    for (const ticker of TARGET_COMPANIES) {
        console.log(`Скануємо ${ticker}...`);

        try {
            // Звертаємося до відкритого API без ключів
            const response = await fetch(`https://api.marketdata.app/v1/options/chain/${ticker}`);
            
            if (response.status === 429) {
                console.log(`⚠️ MarketData: перевищено ліміт запитів. Переходимо до наступного...`);
                await sleep(5000);
                continue;
            }

            const data = await response.json();

            // Якщо сталася помилка на їхньому боці або немає даних
            if (data.s !== "ok") {
                console.log(`⚠️ Немає даних для ${ticker}: ${data.errmsg || 'невідома помилка'}`);
                continue;
            }

            // MarketData повертає дати в Unix-секундах. Знаходимо найближчу дату (найменше число).
            const uniqueExpirations = [...new Set(data.expiration)].sort((a, b) => a - b);
            if (uniqueExpirations.length === 0) continue;

            const nearestExp = uniqueExpirations[0];
            const expDate = new Date(nearestExp * 1000).toISOString().split('T')[0];

            let tickerAnomalies = [];
            let totalCallVol = 0;
            let totalPutVol = 0;
            let totalCallMoney = 0;
            let totalPutMoney = 0;

            // API віддає дані масивами, тому проходимось по індексах
            for (let i = 0; i < data.optionSymbol.length; i++) {
                // Відкидаємо всі контракти, окрім тих, що на найближчу п'ятницю
                if (data.expiration[i] !== nearestExp) continue;

                const type = data.side[i].toUpperCase(); // "CALL" або "PUT"
                const volume = data.volume[i] || 0;
                const openInterest = data.openInterest[i] || 0;
                const lastPrice = data.last[i] || 0;
                const strike = data.strike[i];

                const moneyFlow = volume * lastPrice * 100; // 1 контракт = 100 акцій

                if (type === "CALL") {
                    totalCallVol += volume;
                    totalCallMoney += moneyFlow;
                } else {
                    totalPutVol += volume;
                    totalPutMoney += moneyFlow;
                }

                // УМОВА: Об'єм > 500, перевищує OI в 3 рази, і влито більше $10,000
                if (volume > 500 && volume > (openInterest * 3) && moneyFlow > 10000) {
                    tickerAnomalies.push({
                        type: type,
                        strike: strike,
                        volume: volume,
                        oi: openInterest,
                        money: moneyFlow
                    });
                }
            }

            const totalVolume = totalCallVol + totalPutVol;
            const totalMoney = totalCallMoney + totalPutMoney;
            const moneyPCRatio = totalCallMoney > 0 ? (totalPutMoney / totalCallMoney) : 0;
            
            const hasStrikeAnomaly = tickerAnomalies.length > 0 && tickerAnomalies.reduce((sum, a) => sum + a.money, 0) > 50000;
            const hasDirectionalAnomaly = totalVolume > 10000 && (moneyPCRatio < 0.33 || moneyPCRatio > 3.0);

            if (hasStrikeAnomaly || hasDirectionalAnomaly) {
                foundAnomalies = true;
                
                let sentiment = moneyPCRatio < 0.5 ? "🟢 Бичачий (Скупляють Calls)" : (moneyPCRatio > 2.0 ? "🔴 Ведмежий (Скупляють Puts)" : "🟡 Змішаний");

                finalTelegramMessage += `🏢 <b>${ticker}</b> (Експірація: ${expDate})\n`;
                finalTelegramMessage += `📊 Настрій грошей: ${sentiment}\n`;
                finalTelegramMessage += `💸 Загальний потік: ${formatMoney(totalMoney)} (Calls: ${formatMoney(totalCallMoney)} / Puts: ${formatMoney(totalPutMoney)})\n`;
                
                if (hasDirectionalAnomaly && !hasStrikeAnomaly) {
                    finalTelegramMessage += `🌊 <i>Спрацював радар глобального перекосу (масовий рух в один бік).</i>\n`;
                }

                if (hasStrikeAnomaly) {
                    finalTelegramMessage += `🎯 Точкові аномалії (Крупні угоди):\n`;
                    tickerAnomalies.sort((a, b) => b.money - a.money).slice(0, 3).forEach(a => {
                        let icon = a.type === "CALL" ? "📈" : "📉";
                        finalTelegramMessage += `  ${icon} ${a.type} | Strike: $${a.strike} | Vol: ${a.volume} (OI: ${a.oi}) | ${formatMoney(a.money)}\n`;
                    });
                }
                finalTelegramMessage += `\n`;
            }

            // Пауза 2 секунди між компаніями
            await sleep(2000);

        } catch (error) {
            console.error(`❌ Помилка обробки ${ticker}:`, error.message);
        }
    }
    
    if (foundAnomalies) {
        try {
            await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    chat_id: TELEGRAM_CHAT_ID, 
                    text: finalTelegramMessage, 
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                })
            });
            console.log("📨 Звіт по опціонах успішно відправлено!");
        } catch (err) {
            console.error("Помилка відправки в ТГ:", err);
        }
    } else {
        console.log("Крупних аномальних угод сьогодні не знайдено.");
    }
    
    process.exit(0);
}

runOptionsScanner();
