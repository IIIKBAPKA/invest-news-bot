const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MARKETDATA_TOKEN = process.env.MARKETDATA_TOKEN; 

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
    console.log("🔍 Запуск сканера опціонів (Жорсткі фільтри для Mega-Caps)...");
    
    if (!MARKETDATA_TOKEN) {
        console.error("❌ ПОМИЛКА: Не знайдено MARKETDATA_TOKEN!");
        process.exit(1);
    }

    let finalTelegramMessage = "🐋 <b>РАДАР АНОМАЛЬНИХ ОПЦІОНІВ</b> 🐋\n\n";
    let foundAnomalies = false;

    for (const ticker of TARGET_COMPANIES) {
        console.log(`Скануємо ${ticker}...`);

        try {
            const response = await fetch(`https://api.marketdata.app/v1/options/chain/${ticker}`, {
                headers: {
                    'Authorization': `Bearer ${MARKETDATA_TOKEN}`,
                    'Accept': 'application/json'
                }
            });
            
            if (response.status === 429) {
                console.log(`⚠️ MarketData: перевищено ліміт запитів. Чекаємо 5с...`);
                await sleep(5000);
                continue;
            }

            const data = await response.json();

            if (data.s !== "ok") {
                console.log(`⚠️ Немає даних для ${ticker}: ${data.errmsg || 'невідома помилка'}`);
                continue;
            }

            const uniqueExpirations = [...new Set(data.expiration)].sort((a, b) => a - b);
            if (uniqueExpirations.length === 0) continue;

            const nearestExp = uniqueExpirations[0];
            const expDate = new Date(nearestExp * 1000).toISOString().split('T')[0];

            let tickerAnomalies = [];
            let totalCallVol = 0;
            let totalPutVol = 0;
            let totalCallMoney = 0;
            let totalPutMoney = 0;

            for (let i = 0; i < data.optionSymbol.length; i++) {
                if (data.expiration[i] !== nearestExp) continue;

                const type = data.side[i].toUpperCase(); 
                const volume = data.volume[i] || 0;
                const openInterest = data.openInterest[i] || 0;
                const lastPrice = data.last[i] || 0;
                const strike = data.strike[i];

                const moneyFlow = volume * lastPrice * 100; 

                if (type === "CALL") {
                    totalCallVol += volume;
                    totalCallMoney += moneyFlow;
                } else {
                    totalPutVol += volume;
                    totalPutMoney += moneyFlow;
                }

                // 🎯 НОВИЙ ФІЛЬТР ДЛЯ КИТІВ: Об'єм > 1000, в 4 рази більше за OI, грошей > $50k в один страйк
                if (volume > 1000 && volume > (openInterest * 4) && moneyFlow > 50000) {
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
            
            // 💰 НОВИЙ ФІЛЬТР СУМИ: Сумарно в аномальні страйки влито > $250,000
            const hasStrikeAnomaly = tickerAnomalies.length > 0 && tickerAnomalies.reduce((sum, a) => sum + a.money, 0) > 250000;
            
            // 🌊 НОВИЙ ФІЛЬТР ЦУНАМІ: Загальний об'єм > 50,000 контрактів І грошовий перекіс більше 1 до 4
            const hasDirectionalAnomaly = totalVolume > 50000 && (moneyPCRatio < 0.25 || moneyPCRatio > 4.0);

            if (hasStrikeAnomaly || hasDirectionalAnomaly) {
                foundAnomalies = true;
                
                let sentiment = moneyPCRatio < 0.5 ? "🟢 Бичачий (Скупляють Calls)" : (moneyPCRatio > 2.0 ? "🔴 Ведмежий (Скупляють Puts)" : "🟡 Змішаний");

                finalTelegramMessage += `🏢 <b>${ticker}</b> (Експірація: ${expDate})\n`;
                finalTelegramMessage += `📊 Настрій грошей: ${sentiment}\n`;
                finalTelegramMessage += `💸 Загальний потік: ${formatMoney(totalMoney)} (Calls: ${formatMoney(totalCallMoney)} / Puts: ${formatMoney(totalPutMoney)})\n`;
                
                if (hasDirectionalAnomaly && !hasStrikeAnomaly) {
                    finalTelegramMessage += `🌊 <i>Спрацював радар глобального перекосу (шалений об'єм в один бік).</i>\n`;
                }

                if (hasStrikeAnomaly) {
                    finalTelegramMessage += `🎯 Точкові аномалії (Жирні кити):\n`;
                    tickerAnomalies.sort((a, b) => b.money - a.money).slice(0, 3).forEach(a => {
                        let icon = a.type === "CALL" ? "📈" : "📉";
                        finalTelegramMessage += `  ${icon} ${a.type} | Strike: $${a.strike} | Vol: ${a.volume} (OI: ${a.oi}) | ${formatMoney(a.money)}\n`;
                    });
                }
                finalTelegramMessage += `\n`;
            }

            await sleep(1500);

        } catch (error) {
            console.error(`❌ Помилка обробки ${ticker}:`, error.message);
        }
    }
    
    if (foundAnomalies) {
        // 🛠 Захист від ліміту символів у Telegram (максимум 4096)
        if (finalTelegramMessage.length > 4000) {
            finalTelegramMessage = finalTelegramMessage.substring(0, 4000) + "\n\n✂️ <i>Звіт обрізано через ліміт символів...</i>";
        }

        try {
            const tgResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    chat_id: TELEGRAM_CHAT_ID, 
                    text: finalTelegramMessage, 
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                })
            });
            
            const tgResult = await tgResponse.json();

            if (tgResult.ok) {
                console.log("📨 Звіт по опціонах успішно відправлено!");
            } else {
                console.error("❌ Telegram відмовився приймати повідомлення:", tgResult.description);
                // Відправляємо сирий текст, якщо HTML зламався
                await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        chat_id: TELEGRAM_CHAT_ID, 
                        text: "⚠️ Помилка форматування. Сирий звіт:\n\n" + finalTelegramMessage.replace(/<[^>]*>?/gm, '')
                    })
                });
            }
        } catch (err) {
            console.error("Помилка мережі при відправці в ТГ:", err);
        }
    } else {
        console.log("Крупних аномальних угод сьогодні не знайдено. Ринок спокійний.");
    }
    
    process.exit(0);
}

runOptionsScanner();
