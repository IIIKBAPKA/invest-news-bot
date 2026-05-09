const yahooFinance = require('yahoo-finance2').default;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Наші компанії
const TARGET_COMPANIES = [
    "NVDA", "GOOG", "VST", "AAPL", "TSLA", "DASH", "NEE", "UBER", 
    "CVX", "XOM", "ADBE", "AMZN", "KO", "MSFT", "NFLX", "META", 
    "AMD", "SPY", "QQQ"
];

// Форматування чисел у $100k, $1.5M
const formatMoney = (num) => {
    if (num >= 1000000) return `$${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `$${(num / 1000).toFixed(0)}k`;
    return `$${num.toFixed(0)}`;
};

async function runOptionsScanner() {
    console.log("🔍 Запуск математичного сканера опціонів...");
    
    let finalTelegramMessage = "🐋 <b>РАДАР АНОМАЛЬНИХ ОПЦІОНІВ (КИТИ)</b> 🐋\n\n";
    let foundAnomalies = false;

    for (const ticker of TARGET_COMPANIES) {
        console.log(`Скануємо ${ticker}...`);
        try {
            const queryOptions = { modules: ['options'] };
            const result = await yahooFinance.quoteSummary(ticker, queryOptions);
            
            if (!result.options || result.options.length === 0) continue;
            
            // Беремо найближчу дату експірації (зазвичай п'ятниця цього або наступного тижня)
            const optionsChain = await yahooFinance.options(ticker);
            const nearestExpiration = optionsChain.options[0]; 
            const expDate = new Date(nearestExpiration.expirationDate).toISOString().split('T')[0];

            let tickerAnomalies = [];
            let totalCallVol = 0;
            let totalPutVol = 0;
            let totalMoneyInAnomalies = 0;

            // Функція аналізу контрактів
            const analyzeContracts = (contracts, type) => {
                contracts.forEach(contract => {
                    const volume = contract.volume || 0;
                    const openInterest = contract.openInterest || 0;
                    const lastPrice = contract.lastPrice || 0;
                    
                    // Підрахунок загального об'єму для статистики
                    if (type === "CALL") totalCallVol += volume;
                    if (type === "PUT") totalPutVol += volume;

                    // УМОВА АНОМАЛІЇ: Об'єм > Відкритий інтерес * 3, Об'єм > 500
                    if (volume > 500 && volume > (openInterest * 3)) {
                        // Сума грошей, влитих у цей контракт (в 1 контракті 100 акцій)
                        const moneyFlow = volume * lastPrice * 100;
                        
                        tickerAnomalies.push({
                            type: type,
                            strike: contract.strike,
                            volume: volume,
                            oi: openInterest,
                            money: moneyFlow
                        });
                        
                        totalMoneyInAnomalies += moneyFlow;
                    }
                });
            };

            analyzeContracts(nearestExpiration.calls, "CALL");
            analyzeContracts(nearestExpiration.puts, "PUT");

            // Якщо є аномальні контракти І в них влито більше $50,000 (відсіюємо дрібниці)
            if (tickerAnomalies.length > 0 && totalMoneyInAnomalies > 50000) {
                foundAnomalies = true;
                
                // Рахуємо співвідношення Пут/Колл для розуміння загального настрою
                let putCallRatio = (totalCallVol === 0) ? 0 : (totalPutVol / totalCallVol).toFixed(2);
                let sentiment = putCallRatio < 0.8 ? "🟢 Бичачий (Більше Calls)" : (putCallRatio > 1.2 ? "🔴 Ведмежий (Більше Puts)" : "🟡 Нейтральний");

                finalTelegramMessage += `🏢 <b><a href="https://finance.yahoo.com/quote/${ticker}/options">${ticker}</a></b> (Експірація: ${expDate})\n`;
                finalTelegramMessage += `📊 Настрій дня: ${sentiment} (P/C: ${putCallRatio})\n`;
                finalTelegramMessage += `💰 Влито в аномалії: <b>${formatMoney(totalMoneyInAnomalies)}</b>\n`;
                
                // Сортуємо від найбільших грошей до найменших і беремо топ 3 контракти
                tickerAnomalies.sort((a, b) => b.money - a.money).slice(0, 3).forEach(a => {
                    let icon = a.type === "CALL" ? "📈" : "📉";
                    finalTelegramMessage += `  ${icon} ${a.type} | Strike: $${a.strike} | Vol: ${a.volume} (OI: ${a.oi}) | ${formatMoney(a.money)}\n`;
                });
                
                finalTelegramMessage += `\n`;
            }

            // Пауза 2 секунди, щоб Yahoo не забанив за спам
            await new Promise(r => setTimeout(r, 2000));

        } catch (error) {
            console.error(`❌ Помилка ${ticker}:`, error.message);
        }
    }
    
    // Якщо щось знайшли - відправляємо ОДНЕ повідомлення
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
