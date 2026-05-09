const yf = require('yahoo-finance2');

// Бронебійна ініціалізація
let yahooFinance;
if (yf.YahooFinance) {
    yahooFinance = new yf.YahooFinance(); 
} else if (yf.default) {
    yahooFinance = yf.default; 
} else {
    yahooFinance = new yf();
}

// 🥷 БЕЗПЕЧНЕ МАСКУВАННЯ ПІД БРАУЗЕР
try {
    if (typeof yahooFinance.suppressNotices === 'function') {
        yahooFinance.suppressNotices(['yahooSurvey', 'cookieAndCrumb']);
    }
    if (typeof yahooFinance.setGlobalConfig === 'function') {
        yahooFinance.setGlobalConfig({
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5'
                }
            }
        });
    }
} catch (e) {
    console.log("⚠️ Маскування пропущено через специфіку версії бібліотеки, продовжуємо...");
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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runOptionsScanner() {
    console.log("🔍 Запуск просунутого математичного сканера опціонів...");
    
    let finalTelegramMessage = "🐋 <b>РАДАР АНОМАЛЬНИХ ОПЦІОНІВ</b> 🐋\n\n";
    let foundAnomalies = false;

    for (const ticker of TARGET_COMPANIES) {
        console.log(`Скануємо ${ticker}...`);
        
        let result = null;
        let attempts = 0;
        const maxAttempts = 2; // Якщо жорсткий бан, не мучимо сервер довго

        while (attempts < maxAttempts) {
            try {
                result = await yahooFinance.options(ticker);
                break; 
            } catch (error) {
                attempts++;
                if (error.message.includes('Too Many Requests') || error.message.includes('Unexpected token')) {
                    console.log(`⏳ Yahoo підозрює бота по ${ticker}. Чекаємо 10 секунд... (Спроба ${attempts}/${maxAttempts})`);
                    await sleep(10000);
                } else {
                    console.error(`❌ Помилка ${ticker}:`, error.message);
                    break;
                }
            }
        }

        try {
            if (!result || !result.options || result.options.length === 0) {
                console.log(`⚠️ Немає даних або блокування по ${ticker}`);
                continue;
            }
            
            const nearestExpiration = result.options[0]; 
            const expDate = new Date(nearestExpiration.expirationDate).toISOString().split('T')[0];

            let tickerAnomalies = []; 
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
                    
                    const moneyFlow = volume * lastPrice * 100; 

                    if (type === "CALL") {
                        totalCallVol += volume;
                        totalCallMoney += moneyFlow;
                    } else {
                        totalPutVol += volume;
                        totalPutMoney += moneyFlow;
                    }

                    // Аномалія: Об'єм у 3 рази більший за інтерес + великі гроші
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
            
            const moneyPCRatio = totalCallMoney > 0 ? (totalPutMoney / totalCallMoney) : 0;
            
            const hasStrikeAnomaly = tickerAnomalies.length > 0 && tickerAnomalies.reduce((sum, a) => sum + a.money, 0) > 50000;
            const hasDirectionalAnomaly = totalVolume > 10000 && (moneyPCRatio < 0.33 || moneyPCRatio > 3.0);

            if (hasStrikeAnomaly || hasDirectionalAnomaly) {
                foundAnomalies = true;
                
                let sentiment = moneyPCRatio < 0.5 ? "🟢 Бичачий (Скупляють Calls)" : (moneyPCRatio > 2.0 ? "🔴 Ведмежий (Скупляють Puts)" : "🟡 Змішаний");

                finalTelegramMessage += `🏢 <b><a href="https://finance.yahoo.com/quote/${ticker}/options">${ticker}</a></b> (Експірація: ${expDate})\n`;
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

            // Пауза 5 секунд між компаніями, щоб імітувати повільну людину і не "злити" сервер
            await sleep(5000);

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
