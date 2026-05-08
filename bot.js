const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY; // Додано ключ Finnhub

const TARGET_COMPANIES = {
    "NVDA": ["NVIDIA"],
    "GOOG": ["GOOGLE", "ALPHABET"],
    "VST": ["VISTRA"],
    "AAPL": ["APPLE"],
    "TSLA": ["TESLA"],
    "DASH": ["DOORDASH"],
    "NEE": ["NEXTERA"],
    "UBER": ["UBER"],
    "CVX": ["CHEVRON"],
    "XOM": ["EXXON"],
    "ADBE": ["ADOBE"],
    "AMZN": ["AMAZON"],
    "KO": ["COCA-COLA", "COCA COLA"],
    "MSFT": ["MICROSOFT"],
    "NFLX": ["NETFLIX"],
    "META": ["META PLATFORMS", "FACEBOOK"],
    "AMD": ["ADVANCED MICRO DEVICES"],
    "SPY": ["SPDR S&P 500"],
    "QQQ": ["INVESCO QQQ"],
    "1VOW3": ["VOLKSWAGEN"]
};

// Беремо тільки ключі (тікери) для запитів до Finnhub
const TARGET_TICKERS = Object.keys(TARGET_COMPANIES);

async function run() {
    try {
        console.log("🚀 Запуск моніторингу (Версія: 5.0 Finnhub API)...");
        let allItems = [];
        let sourceStats = {};

        // Отримуємо сьогоднішню дату у форматі YYYY-MM-DD для API
        const today = new Date().toISOString().split('T')[0];

        // 1. ЗБІР ДАНИХ ЧЕРЕЗ API
        for (const ticker of TARGET_TICKERS) {
            try {
                const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${today}&to=${today}&token=${FINNHUB_API_KEY}`;
                const res = await fetch(url);
                
                if (res.ok) {
                    const newsArray = await res.json();
                    
                    // Перетворюємо формат Finnhub під наш старий код
                    const formattedItems = newsArray.map(i => ({
                        title: i.headline,
                        link: i.url,
                        contentSnippet: i.summary,
                        sourceName: i.source || 'Finnhub',
                        pubDate: i.datetime * 1000 // Finnhub віддає в секундах, переводимо в мілісекунди
                    }));

                    allItems = allItems.concat(formattedItems);
                    sourceStats[ticker] = formattedItems.length;
                } else {
                    console.error(`❌ Помилка API для [${ticker}]: Статус ${res.status}`);
                }
                
                // Мікро-пауза, щоб не перевищити ліміт (60 запитів на хвилину)
                await new Promise(r => setTimeout(r, 1000)); 
            } catch (e) {
                console.error(`❌ Помилка з'єднання для [${ticker}]:`, e.message);
            }
        }

        const thirtyFiveMinsAgo = Date.now() - (12 * 60 * 60 * 1000); // Тимчасовий тест на 12 годин 
        let passedBySource = {};

        // 2. ФІЛЬТРАЦІЯ (Тікери вже відфільтровані самим Finnhub, перевіряємо тільки час)
        const filtered = allItems.filter(item => {
            const isFresh = item.pubDate > thirtyFiveMinsAgo;
            
            if (isFresh) {
                passedBySource[item.sourceName] = (passedBySource[item.sourceName] || 0) + 1;
                return true;
            }
            return false;
        });

        if (filtered.length > 0) {
            console.log(`\n🔍 СПИСОК УСІХ ЗНАЙДЕНИХ НОВИН:`);
            filtered.forEach((item, idx) => {
                const timeStr = new Date(item.pubDate).toLocaleTimeString('uk-UA');
                console.log(`${idx + 1}. [${item.sourceName}] [${timeStr}] ${item.title}`);
            });
        }

        // Тільки базова дедуплікація (за ідентичною назвою)
        const uniqueItems = Array.from(new Map(filtered.map(item => [item.title, item])).values());

        console.log(`\n📊 ДЕТАЛЬНА СТАТИСТИКА:`);
        console.log(`- Всього знайдено за сьогодні: ${allItems.length}`);
        console.log(`- Пройшли фільтр (за останні 35хв):`);
        Object.keys(passedBySource).forEach(s => console.log(`  [${s}]: ${passedBySource[s]} пройшло`));
        console.log(`- Унікальних для ШІ: ${uniqueItems.length}\n`);

        if (uniqueItems.length === 0) {
            console.log("☕ Нових подій немає. Завершуємо.");
            process.exit(0);
        }

        // 3. ОБРОБКА ТА ВІДПРАВКА
        for (const item of uniqueItems.slice(0, 10)) {
            console.log(`----------\nОбробка [${item.sourceName}]: ${item.title}`);
            
            let fullText = item.contentSnippet || item.description || "";
            
            // Завжди намагаємось дістати повний текст через Jina, бо Finnhub дає тільки URL
            try {
                const res = await fetch(`https://r.jina.ai/${item.link}`, { signal: AbortSignal.timeout(15000) });
                if (res.ok) {
                    const content = await res.text();
                    fullText = content.slice(0, 8000);
                    console.log("✅ Повний текст отримано.");
                }
            } catch (e) { console.log("⚠️ Тільки сніпет."); }

            await new Promise(r => setTimeout(r, 2000));

            const prompt = `Ти — Senior інвестиційний аналітик. Глибоко проаналізуй новину. 
            Якщо вона НЕ стосується списку компаній: ${Object.keys(TARGET_COMPANIES).join(', ')} або новина неважлива чи просто якийсь факт що щось виросло без конкретики — відповідай SKIP.

            ВАЖЛИВО: Пиши ТІЛЬКИ чистий текст по шаблону (щоб Telegram прийняв)

            КРОК 2: Сформуй звіт по шаблону(HTML, без Markdown):
            🎯 <b>Головне:</b> [Суть події]
            
            🏢 <b>Компанії:</b> [#TICKER]
            📊 <b>Сентимент:</b> [🟢/🔴/🟡]
            🔥 <b>Важливість:</b> [1-10]/10
            
            🧠 <b>Аналіз:</b> [Вплив на ціну]
            
            📈 <b>Опціонний кут:</b> [Стратегії простішою мовою]
            
            ⚔️ <b>Конкуренти:</b> [Тікери]

            Текст: ${item.title} \n ${fullText}`;

            let success = false;
            let attempts = 0;
            const MAX_AI_ATTEMPTS = 4; 

            while (!success && attempts < MAX_AI_ATTEMPTS) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
                    const result = await Promise.race([
                        model.generateContent(prompt),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 40000))
                    ]);

                    const response = result.response.text().trim();

                    if (!response.includes("SKIP")) {
                        let safeResponse = response.replace(/<\/?(?!(b|i|a|code|s|u)\b)[^>]+>/gi, '');
                        const tags = ['b', 'i', 'a', 'code', 's', 'u'];
                        tags.forEach(tag => {
                            const opened = (safeResponse.match(new RegExp(`<${tag}(\\s|>|/)`, 'g')) || []).length;
                            const closed = (safeResponse.match(new RegExp(`</${tag}>`, 'g')) || []).length;
                            if (opened > closed) {
                                safeResponse += `</${tag}>`.repeat(opened - closed);
                            }
                        });

                        const message = `🔔 <b>Новина:</b> <a href="${item.link}">${item.title}</a>\n\n${safeResponse}`;
                        
                        const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
                            signal: AbortSignal.timeout(10000)
                        });

                        if (tgRes.ok) console.log("📨 Надіслано в Telegram.");
                        else {
                            const errData = await tgRes.json();
                            console.error(`❌ Telegram Error: ${errData.description}`);
                        }
                    } else console.log("⏭️ SKIP.");
                    
                    success = true;
                } catch (err) {
                    attempts++;
                    console.log(`⚠️ Помилка AI (Спроба ${attempts}/${MAX_AI_ATTEMPTS})...`);
                    await new Promise(r => setTimeout(r, 2000));
                    
                    if (attempts === MAX_AI_ATTEMPTS) {
                        const fallbackMsg = `🔔 <b>Новина (Без аналізу):</b> <a href="${item.link}">${item.title}</a>\n\n<i>⚠️ AI сервери перевантажені.</i>`;
                        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: fallbackMsg, parse_mode: 'HTML' })
                        });
                        success = true;
                    }
                }
            }
        }
        process.exit(0);
    } catch (error) {
        process.exit(1);
    }
}

run();
