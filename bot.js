const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const parser = new Parser({
    headers: {
        'User-Agent': 'InvestBot/1.0 (your-email@example.com)', // Впиши свою пошту
        'Accept': 'application/atom+xml, application/xml, text/xml',
    },
});
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Джерела: Google News та SEC Filings для твоїх тікерів
const FEEDS = [
    'https://news.google.com/rss/search?q=NVDA+OR+GOOG+OR+VST+OR+"stock+market"+when:1d&hl=en-US&gl=US',
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=&company=&paction=getcurrent&count=40&output=atom' 
    // Примітка: SEC краще фільтрувати в коді по тікерах, бо їхній RSS дуже загальний
];

async function run() {
    try {
        console.log("Запуск перевірки новин та SEC документів...");
        let allItems = [];

        for (const url of FEEDS) {
            try {
                const feed = await parser.parseURL(url);
                allItems = allItems.concat(feed.items);
            } catch (e) {
                console.error(`Помилка парсингу джерела ${url}:`, e.message);
            }
        }

        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);
        
        // Фільтруємо за часом ТА приналежністю до твоїх інтересів
        const recentItems = allItems.filter(item => {
            const pubDate = new Date(item.pubDate || item.isoDate).getTime();
            const content = (item.title + (item.contentSnippet || "")).toUpperCase();
            const isTarget = content.includes("NVDA") || content.includes("GOOG") || content.includes("VST") || content.includes("MARKET");
            return pubDate > thirtyFiveMinsAgo && isTarget;
        });

        if (recentItems.length === 0) {
            console.log("Нових подій за останні 35 хвилин немає.");
            process.exit(0);
        }

        // Видаляємо дублікати за заголовком
        const uniqueItems = Array.from(new Map(recentItems.map(item => [item.title, item])).values());
        console.log(`Знайдено унікальних подій: ${uniqueItems.length}`);
        
        const itemsToProcess = uniqueItems.slice(0, 10); 

        for (const item of itemsToProcess) {
            console.log(`Оброблюємо: ${item.title}`);
            
            const prompt = `Ти — Senior інвестиційний аналітик та експерт з опціонів. 
            Твоє завдання: проаналізувати новину або офіційний документ SEC.

            КРОК 1 (ФІЛЬТР): Якщо це несуттєва технічна новина, клікбейт або рутинний звіт, що не впливає на ціну — відповідай: SKIP.
            Особлива увага SEC Filings: Форма 4 (інсайдери), 8-K (важливі події), 10-Q/K (звіти) — це ВАЖЛИВО.

            КРОК 2: Сформуй звіт СУВОРО за HTML-шаблоном:

            🎯 <b>Головне:</b> [Суть події. Якщо це SEC — вкажи тип форми та хто здійснив дію]

            🏢 <b>Компанії:</b> [Тікери: #NVDA, #GOOG, #VST тощо]
            📊 <b>Сентимент:</b> [🟢 Позитивний / 🔴 Негативний / 🟡 Нейтральний]
            🔥 <b>Важливість:</b> [1-10]/10

            🧠 <b>Аналіз:</b>
            [Як це вплине на акції. Інсайдерська покупка — це часто бичачий сигнал, продаж — залежить від обсягу.]

            📈 <b>Опціонний кут (IV & Strategy):</b>
            [Вплив на IV. Чи варто продавати премію (Iron Condor, Credit Spreads) чи купувати волатильність?]

            ⚔️ <b>Конкуренти:</b> [Тікери через #]

            ВАЖЛИВО: Не використовуй Markdown. Відповідай українською мовою.
            Джерело: ${item.link}
            Подія: ${item.title} — ${item.contentSnippet || item.description}`;

            let responseText = "";
            let attempt = 0;
            const maxAttempts = 3;

            while (attempt < maxAttempts) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
                    const result = await model.generateContent(prompt);
                    responseText = result.response.text().trim();
                    break;
                } catch (err) {
                    attempt++;
                    if (attempt >= maxAttempts) responseText = "ERROR";
                    else await new Promise(res => setTimeout(res, 10000));
                }
            }

            if (responseText.startsWith("SKIP") || responseText === "ERROR") continue; 

            const message = `🔔 <b>Нова подія на ринку</b>\n📰 <a href="${item.link}">${item.title}</a>\n\n${responseText}`;

            await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                })
            });
            
            await new Promise(res => setTimeout(res, 3000));
        }
        process.exit(0);
    } catch (error) {
        console.error("Помилка:", error);
        process.exit(1);
    }
}

run();
