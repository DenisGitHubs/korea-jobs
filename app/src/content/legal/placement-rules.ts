import type { LegalDocByLang } from './types';

/**
 * Posting Rules (RU + EN), version 1.0 — written FROM THE CODE, not invented: every
 * refusal named here is a reason the moderator actually produces (lib/korea/ads/
 * moderation.ts, adspam.ts, parser/prompt.ts) and every property of the week at the
 * top is what lib/korea/ads/featured.ts actually does.
 *
 * 🔴 WHY THIS DOCUMENT EXISTS AT ALL. Until 21.10.2026 the app refused listings with
 * the reason «Объявление нарушает правила размещения» (i18n reject.policy) while no
 * such rules were published anywhere — the refusal pointed at nothing. The same gap
 * would have made the «week at the top» promise unenforceable: we could not remove a
 * polite scammer without breaking our own text (Законник, 21.10.2026).
 *
 * 🔴 TWO PLACES WHERE THE TEXT IS DELIBERATELY NARROWER THAN THE SCREEN NEXT TO IT —
 * do not "fix" them back without reading this:
 *   1. Section 5 is about ONE confirmation the author gives us (no UPFRONT payment for
 *      a place, a visa or paperwork), not a general ban on commissions. Owner's
 *      decision 21.10.2026: what passes between a worker, an intermediary and an
 *      employer is not our business. A broad ban would also contradict our own posting
 *      form, which lets the author declare «Комиссия за трудоустройство: Платно»
 *      (i18n post.*), and the safety screen, which says a salary commission «берут
 *      часто — так бывает».
 *   2. Section 6 says «write to us and we will extend it» rather than promising an
 *      automatic extension: featured.ts ends the week by comparing with now() and has
 *      no compensation mechanism. The extension is a HAND edit of featured_until.
 *      Implement the mechanism and this sentence may become automatic — not before.
 */
export const PLACEMENT_RULES: LegalDocByLang = {
  ru: {
    meta: 'Версия: 1.0 · Дата вступления в силу: 21.10.2026 · Применимое право: законодательство РФ, с оговоркой — если закон страны, где ты проживаешь, даёт тебе больше прав, эти права сохраняются · Язык: правила ведутся на русском и английском; при расхождении текстов приоритет имеет русский.',
    intro:
      'Эти правила мы написали сами, простым языком, без привлечения профессионального юриста, — специально, чтобы их было легко прочитать и понять. Они о том, что можно размещать через раздел «Разместить вакансию» и что будет, если их нарушить. Если что-то осталось неясным — напишите нам: @korea_rabota_bot.',
    sections: [
      {
        heading: '1. О чём эти правила',
        blocks: [
          {
            type: 'p',
            text: 'Правила действуют для объявлений, которые вы размещаете в приложении через «Разместить вакансию». Нажимая «Опубликовать», вы с ними соглашаетесь.',
          },
          {
            type: 'p',
            text: 'Мы — информационная площадка: не работодатель, не кадровое агентство и не посредник в трудоустройстве. За содержание объявления отвечает тот, кто его разместил.',
          },
        ],
      },
      {
        heading: '2. Что можно размещать',
        blocks: [
          {
            type: 'p',
            text: 'Конкретное предложение работы в Корее: что за работа, где она и как с вами связаться. Обязательные поля — заголовок, описание и контакт.',
          },
          {
            type: 'p',
            text: 'Агентства и посредники тоже могут размещать вакансии — но именно вакансии, а не рекламу своих услуг.',
          },
        ],
      },
      {
        heading: '3. Что размещать нельзя',
        blocks: [
          { type: 'p', text: 'Мы отклоняем:' },
          {
            type: 'ul',
            items: [
              'резюме и просьбы «ищу работу» — объявление должно предлагать работу, а не искать её;',
              'разговоры и тексты, в которых не понятно, что это предложение работы;',
              'рекламу: услуг, товаров, курсов (языковых, визовых, водительских), а также рекламу агентства без конкретной вакансии;',
              'аренду жилья и обмен валюты;',
              'спам;',
              'набор в незаконные схемы: обнал, «дропов», аренду банковских карт и счетов, «закладки» и похожее. Обычная работа, за которую платят наличными, к этому не относится.',
            ],
          },
          { type: 'p', text: 'О вашем подтверждении про плату с работников — в разделе 5.' },
        ],
      },
      {
        heading: '4. Как мы смотрим объявления',
        blocks: [
          {
            type: 'p',
            text: 'Мы проверяем только текст: похож ли он на настоящее предложение работы, не спам ли это и не набор в незаконную схему. Текст смотрит программа, в том числе искусственный интеллект. Результат один из трёх:',
          },
          {
            type: 'ul',
            items: [
              '**опубликовано** — объявление в ленте;',
              '**на просмотре** — если программа не уверена, объявление смотрит человек. Пока решения нет, в ленте его не видно. Это не отказ;',
              '**отклонено** — мы называем причину.',
            ],
          },
          {
            type: 'p',
            text: 'Некоторые тексты отклоняются сразу, автоматически, без искусственного интеллекта — если в них есть слова про: рекламу и промокоды; скидки; казино и ставки; криптовалюту и инвестиции; «заработок в интернете» и пассивный доход; розыгрыши и накрутку; эскорт, «18+», интим- и секс-услуги, вебкам; обнал, дропов, аренду карт и счетов. Так бывает и с обычной вакансией, если такое слово попало в текст случайно (например, «скидка на питание для сотрудников»). Уберите слово и отправьте снова.',
          },
          {
            type: 'p',
            text: 'После правки объявления или возврата из архива мы смотрим текст заново. О решении мы сообщаем в приложении, а если вы разрешили боту писать вам — и в Telegram.',
          },
        ],
      },
      {
        heading: '5. Ваше подтверждение про плату с работников',
        blocks: [
          {
            type: 'p',
            text: 'При размещении вы отмечаете галочкой, что не берёте с работников плату вперёд — за место, визу или оформление, до выхода на работу. Мы опираемся на это подтверждение.',
          },
          {
            type: 'p',
            text: 'Если окажется, что подтверждение неверно, мы удалим объявление. Заранее мы этого не проверяем: узнаём из жалоб. Остальные отношения между работником, посредником и работодателем мы не регулируем и не следим за ними.',
          },
        ],
      },
      {
        heading: '6. Неделя вверху ленты',
        blocks: [
          {
            type: 'p',
            text: 'Объявление, которое вы разместили через «Разместить вакансию» и которое опубликовано, неделю показывается вверху ленты — со значком «От автора». Это бесплатно. Откликов и найма мы не обещаем.',
          },
          { type: 'p', text: 'Как это работает:' },
          {
            type: 'ul',
            items: [
              'неделя даётся один раз на объявление. Правка объявления и возврат из архива её не продлевают и не начинают заново;',
              'наверху может быть только одно объявление одного автора. Пока идёт неделя, другие ваши объявления публикуются как обычные;',
              'срок считаем по дням показа. Если сервис не работал — напишите нам, продлим на столько же;',
              'через неделю объявление перестаёт быть наверху ленты;',
              'значок «От автора» значит одно: вы сами оставили это объявление у нас. Он не значит, что мы проверили вас или условия работы.',
            ],
          },
          {
            type: 'p',
            text: '**Подъёма не получает** объявление, в тексте которого есть слова «мужчины», «женщины», «парни» или «девушки» (на английском — men only, women only, male only, female only). Мы ищем эти слова в тексте, поэтому подъёма может не быть, даже если вы написали «мужчины и женщины». Такое объявление публикуется как обычное.',
          },
        ],
      },
      {
        heading: '7. Что мы можем сделать с объявлением',
        blocks: [
          {
            type: 'p',
            text: 'Если объявление нарушает эти правила, мы можем отклонить его, скрыть, а также снять подъём и значок «От автора». Срок подъёма при этом не продлевается.',
          },
        ],
      },
      {
        heading: '8. Как сообщить о нарушении',
        blocks: [
          {
            type: 'p',
            text: 'Откройте вакансию и нажмите «Пожаловаться». Жалоба приходит нам, мы смотрим объявление и решаем, скрыть его или оставить. Сроков рассмотрения мы не называем.',
          },
        ],
      },
      {
        heading: '9. Чего мы не проверяем',
        blocks: [
          {
            type: 'p',
            text: 'Мы не проверяем работодателя, условия работы и правдивость написанного. Место вверху ленты и значок «От автора» — не рекомендация и не оценка объявления.',
          },
        ],
      },
      {
        heading: '10. Изменения и связь',
        blocks: [
          {
            type: 'p',
            text: 'Об изменениях правил мы сообщаем в приложении и/или боте; если вы продолжаете размещать объявления после изменений, это значит, что вы согласны с новой редакцией. Вопросы и жалобы по правилам: @korea_rabota_bot.',
          },
        ],
      },
    ],
  },
  en: {
    meta: 'Version: 1.0 · Effective date: 21 October 2026 · Governing law: the law of the Russian Federation, with one reservation — if the law of the country where you live gives you more rights, those rights remain · Language: the rules are maintained in Russian and English; in case of discrepancy, the Russian text prevails.',
    intro:
      'We wrote these rules ourselves, in plain language, without a professional lawyer — on purpose, so that they are easy to read and understand. They explain what you can post through “Post a job” and what happens if you break them. If anything is unclear, write to us: @korea_rabota_bot.',
    sections: [
      {
        heading: '1. What these rules are about',
        blocks: [
          {
            type: 'p',
            text: 'These rules apply to listings you post in the app through “Post a job”. By tapping “Publish”, you agree to them.',
          },
          {
            type: 'p',
            text: 'We are an information platform: not an employer, not a staffing agency and not an employment intermediary. The person who posts a listing is responsible for what it says.',
          },
        ],
      },
      {
        heading: '2. What you can post',
        blocks: [
          {
            type: 'p',
            text: 'A specific job offer in Korea: what the job is, where it is, and how to reach you. The required fields are a title, a description and a contact.',
          },
          {
            type: 'p',
            text: 'Agencies and intermediaries may post vacancies too — but vacancies, not advertising for their own services.',
          },
        ],
      },
      {
        heading: '3. What you cannot post',
        blocks: [
          { type: 'p', text: 'We reject:' },
          {
            type: 'ul',
            items: [
              'CVs and “looking for work” posts — a listing must offer a job, not look for one;',
              'chat and texts where it is not clear that this is a job offer;',
              'advertising: services, goods, courses (language, visa, driving), and advertising for an agency with no specific vacancy;',
              'housing rentals and currency exchange;',
              'spam;',
              'recruiting into illegal schemes: cash-out, money “drops”, renting out bank cards or accounts, drug-drop work and the like. An ordinary job that pays in cash is not this.',
            ],
          },
          { type: 'p', text: 'About your confirmation on charging workers — see section 5.' },
        ],
      },
      {
        heading: '4. How we review listings',
        blocks: [
          {
            type: 'p',
            text: 'We check only the text: does it look like a real job offer, is it spam, is it recruiting into an illegal scheme. A program reads the text, including artificial intelligence. There are three outcomes:',
          },
          {
            type: 'ul',
            items: [
              '**published** — the listing is in the feed;',
              '**under review** — if the program is unsure, a person looks at the listing. It does not show in the feed until there is a decision. This is not a rejection;',
              '**rejected** — we give the reason.',
            ],
          },
          {
            type: 'p',
            text: 'Some texts are rejected immediately and automatically, without artificial intelligence, if they contain words about: advertising and promo codes; discounts; casinos and betting; cryptocurrency and investments; “earning online” and passive income; giveaways and follower boosting; escort services, “18+”, intimate or sex services, webcam work; cash-out schemes, “drops”, renting out cards or accounts. This can happen to an ordinary job when such a word slips into the text (for example, “discount on meals for staff”). Remove the word and send it again.',
          },
          {
            type: 'p',
            text: 'After you edit a listing or restore it from the archive, we review the text again. We tell you the decision in the app, and in Telegram if you have allowed the bot to message you.',
          },
        ],
      },
      {
        heading: '5. Your confirmation about charging workers',
        blocks: [
          {
            type: 'p',
            text: 'When you post, you tick a box saying you do not charge workers any fees upfront — for a place, a visa or paperwork, before they start work. We rely on this confirmation.',
          },
          {
            type: 'p',
            text: 'If it turns out the confirmation is not true, we delete the listing. We do not check this in advance: we learn of it from complaints. We do not regulate the rest of the relationship between a worker, an intermediary and an employer, and we do not monitor it.',
          },
        ],
      },
      {
        heading: '6. A week at the top of the feed',
        blocks: [
          {
            type: 'p',
            text: 'A listing you posted through “Post a job” that has been published stays at the top of the feed for a week, with a “From the author” badge. This is free. We do not promise responses or hires.',
          },
          { type: 'p', text: 'How it works:' },
          {
            type: 'ul',
            items: [
              'the week is given once per listing. Editing the listing or restoring it from the archive does not extend it or restart it;',
              'only one listing per author can be at the top at a time. While your week is running, your other listings are published as ordinary ones;',
              'we count the week in days the listing is shown. If the service was down, write to us and we will extend it by the same time;',
              'after the week, the listing stops being at the top of the feed;',
              'the “From the author” badge means one thing: you left this listing with us yourself. It does not mean we checked you or the working conditions.',
            ],
          },
          {
            type: 'p',
            text: '**A listing does not get the top spot** if its text contains the words “men”, “women”, “guys” or “girls” in Russian (мужчины, женщины, парни, девушки), or “men only”, “women only”, “male only”, “female only” in English. We look for these words in the text, so the top spot may be refused even if you wrote “men and women”. Such a listing is published as an ordinary one.',
          },
        ],
      },
      {
        heading: '7. What we can do with a listing',
        blocks: [
          {
            type: 'p',
            text: 'If a listing breaks these rules, we may reject it, hide it, and take away its top spot and the “From the author” badge. The week is not extended when we do this.',
          },
        ],
      },
      {
        heading: '8. How to report a violation',
        blocks: [
          {
            type: 'p',
            text: 'Open the listing and tap “Report”. The report comes to us, we look at the listing and decide whether to hide it or keep it. We do not name a time for reviewing reports.',
          },
        ],
      },
      {
        heading: '9. What we do not check',
        blocks: [
          {
            type: 'p',
            text: 'We do not check the employer, the working conditions, or whether what is written is true. A spot at the top of the feed and the “From the author” badge are not a recommendation and not an assessment of the listing.',
          },
        ],
      },
      {
        heading: '10. Changes and contact',
        blocks: [
          {
            type: 'p',
            text: 'We announce changes to these rules in the app and/or the bot; if you keep posting after a change, you accept the new version. Questions and complaints about the rules: @korea_rabota_bot.',
          },
        ],
      },
    ],
  },
};
