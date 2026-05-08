const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const parser = new Parser({
    headers: {
        'User-Agent': 'Anton Vereta (anton012@gmail.com)', 
        'Accept': 'application/atom+xml, application/xml, text/xml',
    },
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Словник для точного пошуку тікерів та назв компаній
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

// Плаский список усіх слів для пошуку (тікери + назви)
const ALL_TARGETS = [...Object.keys(TARGET_COMPANIES), ...Object.values(TARGET_COMPANIES).flat()];

const tickerQuery = Object.keys(TARGET_COMPANIES).join(" OR ");
const FEEDS = [
    { name: 'GoogleNews', url: `https://news.google.com/rss/search?q=${encodeURIComponent(tickerQuery)}+when:1d&hl=en-US&gl=US` },
    // Збільшено count до 100 для SEC, щоб не пропускати важливі звіти
    { name: 'SEC', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=&company=&paction=getcurrent&count=100&output=atom' } 
];

const hasTicker = (text) => {
    const upperText = text.toUpperCase();
    return ALL_TARGETS.some(target => {
        // Шукаємо повне співпадіння слова (\b), щоб не ловити "AMD" у "KODIAK"
        const regex = new RegExp(`\\b${target.toUpperCase()}\\b`, 'i');
        return regex.test(upperText);
    });
};

async function run() {
    try {
        console.log("🚀 Запуск моніторингу (Версія: Повернення до надійного RSS + 32 хв)...");
        let allItems = [];
        let sourceStats = {};

        for (const feedSource of FEEDS) {
            try {
                const feed = await parser.parseURL(feedSource.url);
                const items = feed.items.map(i => ({ ...i, sourceName: feedSource.name }));
                allItems = allItems.concat(items);
                sourceStats[feedSource.name] = items.length;
            } catch (e) {
                console.error(`❌ Помилка джерела [${feedSource.name}]:`, e.message);
            }
        }

        const thirtyFiveMinsAgo = Date.now() - (32 * 60 * 1000); 
        let passedBySource = { GoogleNews: 0, SEC: 0 };

        const filtered = allItems.filter(item => {
            const rawDate = item.pubDate || item.isoDate || 0;
            const pubDate = new Date(rawDate).getTime();
            const isFresh = pubDate > thirtyFiveMinsAgo;
            const isTarget = hasTicker(item.title + " " + (item.contentSnippet || ""));
            
            if (isFresh && isTarget) {
                passedBySource[item.sourceName]++;
                return true;
            }
            return false;
        });

        if (filtered.length > 0) {
            console.log(`\n🔍 СПИСОК УСІХ ЗНАЙДЕНИХ НОВИН (ДО ДЕДУПЛІКАЦІЇ):`);
            filtered.forEach((item, idx) => {
                const timeStr = item.pubDate || item.isoDate || "Невідомий час";
                console.log(`${idx + 1}. [${item.sourceName}] [${timeStr}] ${item.title}`);
            });
        }

        // Тільки базова дедуплікація (за ідентичною назвою)
        const uniqueItems = Array.from(new Map(filtered.map(item => [item.title, item])).values());

        console.log(`\n📊 ДЕТАЛЬНА СТАТИСТИКА:`);
        console.log(`- Всього знайдено: ${allItems.length}`);
        Object.keys(sourceStats).forEach(s => console.log(`  [${s}]: ${sourceStats[s]} завантажено`));
        console.log(`- Пройшли фільтр (32хв + Тікер/Назва):`);
        Object.keys(passedBySource).forEach(s => console.log(`  [${s}]: ${passedBySource[s]} пройшло`));
        console.log(`- Унікальних для ШІ: ${uniqueItems.length}\n`);

        if (uniqueItems.length === 0) {
            console.log("☕ Нових подій немає. Завершуємо.");
            process.exit(0);
        }

        for (const item of uniqueItems.slice(0, 10)) {
            console.log(`----------\nОбробка [${item.sourceName}]: ${item.title}`);
            
            let fullText = item.contentSnippet || item.description || "";
            if (item.sourceName === 'GoogleNews') {
                try {
                    const res = await fetch(`https://r.jina.ai/${item.link}`, { signal: AbortSignal.timeout(15000) });
                    if (res.ok) {
                        const content = await res.text();
                        fullText = content.slice(0, 8000);
                        console.log("✅ Повний текст отримано.");
                    }
                } catch (e) { console.log("⚠️ Тільки сніпет."); }
            }

            await new Promise(r => setTimeout(r, 2000));

            const prompt = `Ти — Senior інвестиційний аналітик. Глибоко проаналізуй новину. 
            Якщо вона НЕ стосується тікерів: ${Object.keys(TARGET_COMPANIES).join(', ')} або новина неважлива (ти визначив Важливість по шаблону як <=3) чи просто інформаційний шум без конкретної новини — відповідай SKIP.

            ВАЖЛИВО: Пиши ТІЛЬКИ чистий текст, але зі смайлами і тегами шаблону (головне щоб цей синтаксис telegram прийняв). 

            КРОК 2: Сформуй звіт (HTML, без Markdown):
            🎯 <b>Головне:</b> [Суть події без води]
            
            🏢 <b>Компанії:</b> [#TICKER]
            📊 <b>Сентимент:</b> [🟢/🔴/🟡]
            🔥 <b>Важливість:</b> [1-10]/10
            
            🧠 <b>Аналіз:</b> [Вплив на ціну акції, логіка руху]
            
            📈 <b>Опціонний кут:</b> [IV та стратегії: Iron Condor, Spreads тощо. Пиши простою мовою, як для новачка]
            
            ⚔️ <b>Конкуренти:</b> [Тікери конкурентів та короткий вплив на них]

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
        console.error("💥 Критична помилка виконання:", error);
        process.exit(1);
    }
}

run();
