const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const rawToken = process.env.MARKETDATA_TOKEN || "";
const MARKETDATA_TOKEN = rawToken.trim(); 

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
    console.log("🔍 Запуск сканера опціонів (Економія лімітів API)...");
    
    if (!MARKETDATA_TOKEN) {
        console.error("❌ ПОМИЛКА: Не знайдено MARKETDATA_TOKEN!");
        process.exit(1);
    } else {
        console.log(`🔑 Токен знайдено! Довжина: ${MARKETDATA_TOKEN.length} символів.`);
    }

    let finalTelegramMessage = "🐋 <b>РАДАР ОБ'ЄМУ ОПЦІОНІВ</b> 🐋\n\n";
    let foundAnomalies = false;

    for (const ticker of TARGET_COMPANIES) {
        console.log(`Скануємо ${ticker}...`);

        try {
            // КРОК 1: Отримуємо тільки дати експірації (Коштує 1 кредит)
            const expResponse = await fetch(`https://api.marketdata.app/v1/options/expirations/${ticker}`, {
                headers: {
                    'Authorization': `Bearer ${MARKETDATA_TOKEN}`,
                    'Accept': 'application/json'
                }
            });

            if (expResponse.status === 429) {
                console.log(`⚠️ MarketData (429): Денний ліміт вичерпано.`);
                break; // Немає сенсу мучити інші тікери, якщо ліміт закінчився
            }

            const expData = await expResponse.json();
            if (expData.s !== "ok" || !expData.expirations || expData.expirations.length === 0) {
                console.log(`⚠️ Немає дат експірації для ${ticker}`);
                continue;
            }

            // Беремо найближчу дату (наприклад "2026-05-15")
            const nearestExpDate = expData.expirations.sort()[0];

            // КРОК 2: Запитуємо ланцюг опціонів ТІЛЬКИ на цю дату (Коштує ще 1 кредит)
            const response = await fetch(`https://api.marketdata.app/v1/options/chain/${ticker}?expiration=${nearestExpDate}`, {
                headers: {
                    'Authorization': `Bearer ${MARKETDATA_TOKEN}`,
                    'Accept': 'application/json'
                }
            });

            const data = await response.json();

            if (data.s !== "ok") {
                console.log(`⚠️ Немає даних опціонів для ${ticker}`);
                continue;
            }

            let totalCallVol = 0, totalPutVol = 0;
            let totalCallMoney = 0, totalPutMoney = 0;

            // Збираємо тотали
            for (let i = 0; i < data.optionSymbol.length; i++) {
                const type = data.side[i].toUpperCase(); 
                const volume = data.volume[i] || 0;
                const moneyFlow = volume * (data.last[i] || 0) * 100; 

                if (type === "CALL") {
                    totalCallVol += volume;
                    totalCallMoney += moneyFlow;
                } else {
                    totalPutVol += volume;
                    totalPutMoney += moneyFlow;
                }
            }

            const totalVolume = totalCallVol + totalPutVol;
            const totalMoney = totalCallMoney + totalPutMoney;
            const moneyPCRatio = totalCallMoney > 0 ? (totalPutMoney / totalCallMoney) : 0;

            // Динамічні пороги для фільтрації шуму
            const dynamicMoneyThreshold = Math.max(50000, totalMoney * 0.015); 
            const dynamicVolThreshold = Math.max(500, totalVolume * 0.01);

            let tickerAnomalies = [];

            // Шукаємо аномалії
            for (let i = 0; i < data.optionSymbol.length; i++) {
                const volume = data.volume[i] || 0;
                const openInterest = data.openInterest[i] || 0;
                const moneyFlow = volume * (data.last[i] || 0) * 100; 

                if (volume > dynamicVolThreshold && volume > (openInterest * 4) && moneyFlow > dynamicMoneyThreshold) {
                    tickerAnomalies.push({
                        type: data.side[i].toUpperCase(),
                        strike: data.strike[i],
                        volume: volume,
                        oi: openInterest,
                        money: moneyFlow
                    });
                }
            }
            
            const sumOfAnomalies = tickerAnomalies.reduce((sum, a) => sum + a.money, 0);
            const hasStrikeAnomaly = tickerAnomalies.length > 0 && sumOfAnomalies > Math.max(250000, totalMoney * 0.03);
            const hasDirectionalAnomaly = totalVolume > 50000 && (moneyPCRatio < 0.25 || moneyPCRatio > 4.0);

            if (hasStrikeAnomaly || hasDirectionalAnomaly) {
                foundAnomalies = true;
                
                let sentiment = moneyPCRatio < 0.5 ? "🟢 Бичачий (Скупляють Calls)" : (moneyPCRatio > 2.0 ? "🔴 Ведмежий (Скупляють Puts)" : "🟡 Змішаний");

                finalTelegramMessage += `🏢 <b>${ticker}</b> (Експірація: ${nearestExpDate})\n`;
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

            // Робимо невелику паузу, щоб не відправити занадто багато запитів за секунду
            await sleep(1000);

        } catch (error) {
            console.error(`❌ Помилка обробки ${ticker}:`, error.message);
        }
    }
    
    if (foundAnomalies) {
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
