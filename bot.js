const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- НАЛАШТУВАННЯ ПАРСЕРІВ ---

// 1. Маскування під браузер для Seeking Alpha ТА Wall Street Journal
const parserBrowser = new Parser({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
});

// 2. Для SEC (вимога ідентифікації)
const parserSEC = new Parser({
    headers: {
        'User-Agent': 'Anton Vereta (anton012@gmail.com)', // Ваша актуальна пошта
        'Accept': 'application/atom+xml, application/xml, text/xml',
    },
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const TARGET_COMPANIES = {
    "NVDA": ["NVIDIA"], "GOOG": ["GOOGLE", "ALPHABET"], "VST": ["VISTRA"],
    "AAPL": ["APPLE"], "TSLA": ["TESLA"], "DASH": ["DOORDASH"],
    "NEE": ["NEXTERA"], "UBER": ["UBER"], "CVX": ["CHEVRON"],
    "XOM": ["EXXON"], "ADBE": ["ADOBE"], "AMZN": ["AMAZON"],
    "KO": ["COCA-COLA", "COCA COLA"], "MSFT": ["MICROSOFT"],
    "NFLX": ["NETFLIX"], "META": ["META PLATFORMS", "FACEBOOK"],
    "AMD": ["ADVANCED MICRO DEVICES"], "SPY": ["SPDR S&P 500"],
    "QQQ": ["INVESCO QQQ"], "1VOW3": ["VOLKSWAGEN"]
};

const ALL_TARGETS = [...Object.keys(TARGET_COMPANIES), ...Object.values(TARGET_COMPANIES).flat()];

// Формуємо список посилань (Додано WSJ)
const FEEDS = [
    { name: 'SEC', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=&company=&paction=getcurrent&count=100&output=atom' },
    { name: 'WSJ_Markets', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml' },
    { name: 'WSJ_Business', url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml' }
];

Object.keys(TARGET_COMPANIES).forEach(ticker => {
    FEEDS.push({ 
        name: 'SeekingAlpha', 
        url: `https://seekingalpha.com/api/sa/combined/${ticker}.xml` 
    });
});

const hasTicker = (text) => {
    const upperText = text.toUpperCase();
    return ALL_TARGETS.some(target => {
        const regex = new RegExp(`\\b${target.toUpperCase()}\\b`, 'i');
        return regex.test(upperText);
    });
};

async function run() {
    try {
        console.log("🚀 Запуск моніторингу (Seeking Alpha + WSJ + SEC | ТЕСТОВИЙ РЕЖИМ 24г)...");
        let allItems = [];
        let sourceStats = { SeekingAlpha: 0, SEC: 0, WSJ_Markets: 0, WSJ_Business: 0 };

        for (const feedSource of FEEDS) {
            try {
                // Вибираємо правильний парсер: для SEC свій, для всіх інших (SA, WSJ) - браузерний
                const currentParser = (feedSource.name === 'SEC') ? parserSEC : parserBrowser;
                
                const feed = await currentParser.parseURL(feedSource.url);
                const items = feed.items.map(i => ({ ...i, sourceName: feedSource.name }));
                allItems = allItems.concat(items);
                sourceStats[feedSource.name] += items.length;
            } catch (e) {
                if (feedSource.name === 'SEC') {
                    console.error(`❌ Помилка SEC (${feedSource.url}):`, e.message);
                }
            }
        }

        // ПЕРІОД ПЕРЕВІРКИ (Зараз 24 години для тесту, потім змініть на 17 * 60 * 1000)
        const windowTime = Date.now() - (24 * 60 * 60 * 1000); 
        let passedBySource = { SeekingAlpha: 0, SEC: 0, WSJ_Markets: 0, WSJ_Business: 0 };

        const filtered = allItems.filter(item => {
            const rawDate = item.pubDate || item.isoDate || 0;
            const pubDate = new Date(rawDate).getTime();
            const isFresh = pubDate > windowTime;
            // Шукаємо згадки в заголовку та сніпеті
            const isTarget = hasTicker(item.title + " " + (item.contentSnippet || ""));
            
            if (isFresh && isTarget) {
                passedBySource[item.sourceName]++;
                return true;
            }
            return false;
        });

        // Видалення дублікатів
        const uniqueItems = Array.from(new Map(filtered.map(item => [item.title, item])).values());

        console.log(`\n📊 СТАТИСТИКА:`);
        console.log(`- Всього завантажено: ${allItems.length}`);
        console.log(`- З них SA: ${sourceStats.SeekingAlpha}, SEC: ${sourceStats.SEC}, WSJ: ${sourceStats.WSJ_Markets + sourceStats.WSJ_Business}`);
        console.log(`- Пройшли фільтр: SA: ${passedBySource.SeekingAlpha}, SEC: ${passedBySource.SEC}, WSJ: ${passedBySource.WSJ_Markets + passedBySource.WSJ_Business}`);
        console.log(`- Унікальних для ШІ: ${uniqueItems.length}\n`);

        if (uniqueItems.length === 0) {
            console.log("☕ Нових подій немає. Завершуємо.");
            process.exit(0);
        }

        // ОБМЕЖЕННЯ 10 НОВИН (для тесту)
        for (const item of uniqueItems.slice(0, 10)) {
            console.log(`----------\nОбробка [${item.sourceName}]: ${item.title}`);
            
            let fullText = item.contentSnippet || item.description || "";
            // Для SeekingAlpha та WSJ пробуємо витягнути повний текст через Jina
            if (item.sourceName === 'SeekingAlpha' || item.sourceName.includes('WSJ')) {
                try {
                    const res = await fetch(`https://r.jina.ai/${item.link}`, { signal: AbortSignal.timeout(15000) });
                    if (res.ok) fullText = (await res.text()).slice(0, 8000);
                } catch (e) { console.log("⚠️ Не вдалося отримати повний текст, використовуємо сніпет."); }
            }

            const prompt = `Ти — Senior інвестиційний аналітик. Глибоко проаналізуй новину. 
            Якщо вона НЕ стосується тікерів: ${Object.keys(TARGET_COMPANIES).join(', ')} або новина неважлива (ти визначив Важливість по шаблону як <=3) чи просто інформаційний шум без конкретної новини — відповідай SKIP.

            ВАЖЛИВО: Пиши ТІЛЬКИ чистий текст, але зі смайлами і тегами шаблону (головне щоб цей синтаксис telegram прийняв). 

            КРОК 2: Сформуй звіт (HTML, без Markdown):
            🎯 <b>Головне:</b> [Зроби тут як новинний заголовок про що вона]
            
            🏢 <b>Компанії:</b> [#TICKER]
            📊 <b>Сентимент:</b> [🟢/🔴/🟡]
            🔥 <b>Важливість:</b> [1-10]/10
            
            🧠 <b>Аналіз:</b> [Вплив на ціну акції, логіка руху]
            
            📈 <b>Опціонний кут:</b> [IV та стратегії: Iron Condor, Spreads тощо. Пиши простою мовою, як для новачка]
            
            ⚔️ <b>Конкуренти:</b> [Тікери конкурентів та короткий вплив на них]

            📍Показники:
            Ціна: [Тут напиши поточну ціну цієї компанії]/Справедлива ціна: [Тут напиши справедливу ціну компанії на твою думку]
            P/E: [Тут напиши поточне p/e цієї компанії]
            RSI: [Тут напиши поточний RSI цієї компанії]

            Текст: ${item.title} \n ${fullText}`;

            let success = false;
            let attempts = 0;
            while (!success && attempts < 3) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-8b" });
                    const result = await Promise.race([
                        model.generateContent(prompt),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 20000))
                    ]);

                    const response = result.response.text().trim();

                    if (!response.includes("SKIP")) {
                        let safeResponse = response.replace(/<\/?(?!(b|i|a|code|s|u)\b)[^>]+>/gi, '');
                        
                        const message = `🔔 <b>Новина:</b> <a href="${item.link}">${item.title}</a>\n\n${safeResponse}`;
                        
                        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true })
                        });
                        console.log("📨 Надіслано в Telegram.");
                    } else console.log("⏭️ SKIP (недостатньо важлива або не в списку).");
                    
                    success = true;
                } catch (err) {
                    attempts++;
                    console.log(`⚠️ Помилка AI (Спроба ${attempts}/3): ${err.message}`);
                    if (attempts < 3) await new Promise(r => setTimeout(r, 3000));
                    else {
                        const fallbackMsg = `🔔 <b>Новина:</b> <a href="${item.link}">${item.title}</a>\n\n<i>⚠️ ШІ не зміг проаналізувати цю новину.</i>`;
                        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: fallbackMsg, parse_mode: 'HTML' })
                        });
                        success = true;
                    }
                }
            }
            await new Promise(r => setTimeout(r, 2000));
        }
        process.exit(0);
    } catch (error) {
        console.error("💥 Помилка:", error);
        process.exit(1);
    }
}

run();
