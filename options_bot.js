const yf = require('yahoo-finance2');

// Бронебійна ініціалізація для обходу проблеми з версіями
let yahooFinance;
if (yf.YahooFinance) {
    yahooFinance = new yf.YahooFinance(); 
} else if (yf.default) {
    yahooFinance = yf.default; 
} else {
    yahooFinance = new yf();
}

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

// Допоміжна функція для пауз
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runOptionsScanner() {
    console.log("🔍 Запуск просунутого математичного сканера опціонів...");
    
    let finalTelegramMessage = "🐋 <b>РАДАР АНОМАЛЬНИХ ОПЦІОНІВ</b> 🐋\n\n";
    let foundAnomalies = false;

    for (const ticker of TARGET_COMPANIES) {
        console.log(`Скануємо ${ticker}...`);
        
        let result = null;
        let attempts = 0;
        const maxAttempts = 3;

        // Блок із повторними спробами (Retry Logic) для захисту від бана
        while (attempts < maxAttempts) {
            try {
                result = await yahooFinance.options(ticker);
                break; // Якщо успішно - виходимо з циклу спроб
            } catch (error) {
                attempts++;
                if (error.message.includes('Too Many Requests') || error.message.includes('Unexpected token')) {
                    console.log(`⏳ Yahoo лімітує запити по ${ticker}. Чекаємо 15 секунд... (Спроба ${attempts}/${maxAttempts})`);
                    await sleep(15000);
                } else {
                    console.error(`❌ Критична помилка ${ticker}:`, error.message);
                    break;
                }
            }
        }

        try {
            if (!result || !result.options || result.options.length === 0) {
                console.log(`⚠️ Немає даних по опціонах для ${ticker}`);
                continue;
            }
            
            // Беремо найближчу дату експірації
            const nearestExpiration = result.options[0]; 
            const expDate = new Date(nearestExpiration.expirationDate).toISOString().split('T')[0];

            let tickerAnomalies = []; 
            
            // Глобальна статистика по тикеру за день
            let totalCallVol = 0;
            let totalPutVol = 0;
            let totalCallMoney = 0;
            let totalPutMoney = 0;

            const analyzeContracts = (contracts, type) => {
                if (!contracts) return;
                
                contracts.forEach(contract => {
                    const volume = contract.volume || 0;
                    const openInterest = contract.openInterest || 0;
                    const lastPrice = contract.lastPrice || 0;
                    
                    const moneyFlow = volume * lastPrice * 100; // В 1 контракті 100 акцій

                    // Глобальна статистика
                    if (type === "CALL") {
                        totalCallVol += volume;
                        totalCallMoney += moneyFlow;
                    } else {
                        totalPutVol += volume;
                        totalPutMoney += moneyFlow;
                    }

                    // ТОЧКОВА АНОМАЛІЯ: Об'єм > OI * 3, Об'єм > 500, грошей > $10,000
                    if (volume > 500 && volume > (openInterest * 3) && moneyFlow > 10000) {
                        tickerAnomalies.push({
                            type: type,
                            strike: contract.strike,
                            volume: volume,
                            oi: openInterest,
                            money: moneyFlow
                        });
                    }
                });
            };

            analyzeContracts(nearestExpiration.calls, "CALL");
            analyzeContracts(nearestExpiration.puts, "PUT");

            const totalVolume = totalCallVol + totalPutVol;
            const totalMoney = totalCallMoney + totalPutMoney;
            
            // Рахуємо грошовий перекіс (Money Sentiment)
            const moneyPCRatio = totalCallMoney > 0 ? (totalPutMoney / totalCallMoney) : 0;
            
            // УМОВИ ДЛЯ ВІДПРАВКИ АЛЕРТУ:
            // 1. Є конкретні жирні аномалії на суму > $50k (Точковий кит)
            const hasStrikeAnomaly = tickerAnomalies.length > 0 && tickerAnomalies.reduce((sum, a) => sum + a.money, 0) > 50000;
            
            // 2. АБО є глобальний перекіс (Цунамі): об'єм більше 10k контрактів І грошей влито в 3 рази більше в один бік
            const hasDirectionalAnomaly = totalVolume > 10000 && (moneyPCRatio < 0.33 || moneyPCRatio > 3.0);

            if (hasStrikeAnomaly || hasDirectionalAnomaly) {
                foundAnomalies = true;
                
                let sentiment = moneyPCRatio < 0.5 ? "🟢 Бичачий (Скупляють Calls)" : (moneyPCRatio > 2.0 ? "🔴 Ведмежий (Скупляють Puts)" : "🟡 Змішаний");

                finalTelegramMessage += `🏢 <b><a href="https://finance.yahoo.com/quote/${ticker}/options">${ticker}</a></b> (Експірація: ${expDate})\n`;
                finalTelegramMessage += `📊 Настрій грошей: ${sentiment}\n`;
                finalTelegramMessage += `💸 Загальний грошовий потік: ${formatMoney(totalMoney)} (Calls: ${formatMoney(totalCallMoney)} / Puts: ${formatMoney(totalPutMoney)})\n`;
                
                if (hasDirectionalAnomaly && !hasStrikeAnomaly) {
                    finalTelegramMessage += `🌊 <i>Спрацював радар глобального перекосу (масовий рух в один бік).</i>\n`;
                }

                if (hasStrikeAnomaly) {
                    finalTelegramMessage += `🎯 Точкові аномалії (Крупні угоди):\n`;
                    // Сортуємо від найбільших грошей до найменших (топ 3)
                    tickerAnomalies.sort((a, b) => b.money - a.money).slice(0, 3).forEach(a => {
                        let icon = a.type === "CALL" ? "📈" : "📉";
                        finalTelegramMessage += `  ${icon} ${a.type} | Strike: $${a.strike} | Vol: ${a.volume} (OI: ${a.oi}) | ${formatMoney(a.money)}\n`;
                    });
                }
                
                finalTelegramMessage += `\n`;
            }

            // Захист від бана по IP від Yahoo (4 секунди після успішного запиту)
            await sleep(4000);

        } catch (error) {
            console.error(`❌ Помилка обробки даних ${ticker}:`, error.message);
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
