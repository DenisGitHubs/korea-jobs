import type { LegalDocByLang } from './types';

/**
 * Referral Program Rules (RU + EN), version 1.0 — the text the owner approved for
 * publication. Every "write to us" pointer resolves to the project bot
 * @korea_rabota_bot (Settings also exposes it as a tappable row).
 */
export const REFERRAL_RULES: LegalDocByLang = {
  ru: {
    meta: 'Версия: 1.0 · Дата вступления в силу: 27.07.2026 · Применимое право: законодательство РФ, с оговоркой — если закон страны, где ты проживаешь, даёт тебе больше прав, эти права сохраняются · Язык: правила ведутся на русском и английском; при расхождении текстов приоритет имеет русский.',
    intro:
      'Эти правила мы написали сами, простым языком, без привлечения профессионального юриста, — специально, чтобы их было легко прочитать и понять. Если что-то осталось неясным или вызывает вопросы — напиши нам: @korea_rabota_bot.',
    sections: [
      {
        heading: '1. Кто проводит программу',
        blocks: [
          {
            type: 'p',
            text: 'Организатор программы — физическое лицо, без статуса ИП и без образования компании, оператор приложения «Корея — вакансии» и бота @korea_rabota_bot. По вопросам программы пиши: @korea_rabota_bot.',
          },
        ],
      },
      {
        heading: '2. Что такое баллы',
        blocks: [
          {
            type: 'p',
            text: 'Баллы — это внутренние условные единицы приложения. Так мы говорим «спасибо за развитие сообщества» тем, кто приглашает знакомых.',
          },
          { type: 'p', text: 'Чем баллы **не являются**:' },
          {
            type: 'ul',
            items: [
              'это не деньги и не электронные денежные средства;',
              'у баллов нет номинальной (денежной) стоимости;',
              'баллы нельзя вывести, обменять на деньги или на что-либо ценное;',
              'баллы нельзя передать, подарить или продать другому пользователю — они привязаны только к твоему аккаунту.',
            ],
          },
        ],
      },
      {
        heading: '3. Как начисляются баллы',
        blocks: [
          {
            type: 'p',
            text: 'Баллы начисляются, когда приглашённый тобой человек совершает целевое действие — впервые открывает контакт работодателя в приложении.',
          },
          {
            type: 'p',
            text: 'Баллы могут начисляться не только за тех, кого ты пригласил напрямую, но и за цепочку из приглашённых ими людей — до трёх уровней вглубь.',
          },
          { type: 'p', text: 'Уточнения:' },
          {
            type: 'ul',
            items: [
              'Точные ставки (сколько баллов и за какой уровень цепочки) могут время от времени меняться — актуальные цифры всегда показаны в приложении.',
              'Начисление может происходить не мгновенно — иногда нужно время, чтобы подтвердить, что действие настоящее.',
              'Мы вправе устанавливать лимиты (например, на количество баллов в день или засчитываемых приглашений).',
              'При признаках накрутки или нарушения правил мы вправе не начислить баллы или аннулировать уже начисленные — без каких-либо компенсаций.',
            ],
          },
        ],
      },
      {
        heading: '4. Что дают баллы сейчас и в будущем',
        blocks: [
          {
            type: 'p',
            text: 'Сейчас баллы можно только накапливать — они отражают твой вклад в развитие сообщества.',
          },
          {
            type: 'p',
            text: 'В будущем мы планируем ввести дополнительные внутренние бонусы за накопленные баллы — например, промокоды и скидки от партнёров сервиса. Это предварительные планы: мы не гарантируем их появление, не называем сроков и вправе изменить или отменить их.',
          },
        ],
      },
      {
        heading: '5. Мы можем менять или закрывать программу',
        blocks: [
          {
            type: 'p',
            text: 'Организатор вправе в любой момент, без предварительного уведомления и объяснения причин:',
          },
          {
            type: 'ul',
            items: [
              'изменить правила, ставки начисления, лимиты и условия программы;',
              'приостановить или полностью закрыть программу;',
              'аннулировать баллы, полученные с нарушением правил.',
            ],
          },
          { type: 'p', text: 'Такие изменения не дают участникам права на компенсацию.' },
        ],
      },
      {
        heading: '6. Программа бесплатна и это не заработок',
        blocks: [
          { type: 'p', text: 'Участие в программе бесплатное и не требует вложений или покупок.' },
          {
            type: 'p',
            text: 'Баллы — это не заработок, не доход и не инвестиция. Участвуя в программе, ты не заключаешь с организатором сделку об оплате труда, инвестировании или получении дохода.',
          },
          {
            type: 'p',
            text: 'Эти правила не являются публичной офертой в смысле статьи 437 Гражданского кодекса РФ и не публичным обещанием награды в смысле статьи 1055 ГК РФ — организатор не берёт на себя обязательство выплатить деньги или передать имущество за приглашения.',
          },
        ],
      },
      {
        heading: '7. Что запрещено',
        blocks: [
          { type: 'p', text: 'Нельзя:' },
          {
            type: 'ul',
            items: [
              'накручивать приглашения (боты, фейковые или купленные аккаунты);',
              'приглашать самого себя через другие аккаунты;',
              'рассылать спам ради приглашений;',
              'любым иным способом обманывать систему подсчёта.',
            ],
          },
          {
            type: 'p',
            text: 'При обнаружении — мы вправе аннулировать баллы, ограничить или заблокировать участие в программе (при серьёзных нарушениях — доступ к приложению).',
          },
        ],
      },
      {
        heading: '8. Персональные данные',
        blocks: [
          {
            type: 'p',
            text: 'Работа программы связана с обработкой твоих персональных данных (кто кого пригласил, факт активации). Подробности — в нашей Политике конфиденциальности, которая доступна в этом же разделе приложения. Участвуя в программе, ты соглашаешься с этой политикой.',
          },
        ],
      },
      {
        heading: '9. Ответственность за действия работодателей и третьих лиц',
        blocks: [
          {
            type: 'p',
            text: 'Организатор не отвечает за действия, вакансии и обещания работодателей и других третьих лиц, размещённые или упомянутые в приложении — подробнее о статусе площадки читай в других информационных разделах приложения.',
          },
        ],
      },
      {
        heading: '10. Территория, язык и применимое право',
        blocks: [
          {
            type: 'p',
            text: 'Программа доступна пользователям приложения независимо от страны, кроме случаев, когда участие в подобных программах запрещено законом страны, где ты живёшь, — тогда участвовать нельзя. Правила ведутся на русском и английском; при расхождении текстов приоритет имеет русский.',
          },
          {
            type: 'p',
            text: 'К отношениям по программе применяется законодательство Российской Федерации. Если закон страны, где ты живёшь, даёт тебе как участнику больше прав, чем эта редакция правил, — эти права за тобой сохраняются.',
          },
          {
            type: 'p',
            text: 'Дата вступления в силу текущей редакции: 27.07.2026. Версия: 1.0. Об изменениях сообщаем в приложении и/или боте; продолжение использования программы после изменений означает согласие с новой редакцией.',
          },
        ],
      },
      {
        heading: '11. Возраст участников',
        blocks: [
          {
            type: 'p',
            text: 'Участвовать в программе может пользователь, которому есть 18 лет. Присоединяясь к программе, ты подтверждаешь, что тебе есть 18 лет.',
          },
        ],
      },
    ],
  },
  en: {
    meta: 'Version: 1.0 · Effective date: 27 July 2026 · Governing law: laws of the Russian Federation, with the reservation that if the law of your country of residence gives you more rights, those rights remain in force · Language: the program runs in Russian and English; in case of discrepancy, the Russian text prevails.',
    intro:
      "We wrote these rules ourselves, in plain language, without hiring a professional lawyer — specifically so they'd be easy to read and understand. If anything is unclear or raises questions, write to us: @korea_rabota_bot.",
    sections: [
      {
        heading: '1. Who runs the program',
        blocks: [
          {
            type: 'p',
            text: 'The organizer is a private individual, with no registered business entity, operating the "Korea Jobs" app and the @korea_rabota_bot. For questions about the program, write to: @korea_rabota_bot.',
          },
        ],
      },
      {
        heading: '2. What points are',
        blocks: [
          {
            type: 'p',
            text: 'Points are internal, app-specific units. They\'re our way of saying "thank you for helping the community grow" when you invite people you know.',
          },
          { type: 'p', text: 'What points are **not**:' },
          {
            type: 'ul',
            items: [
              'they are not money or electronic money;',
              'points have no face (monetary) value;',
              'points cannot be withdrawn, exchanged for money, or exchanged for anything of value;',
              'points cannot be transferred, gifted, or sold to another user — they are tied only to your own account.',
            ],
          },
        ],
      },
      {
        heading: '3. How points are earned',
        blocks: [
          {
            type: 'p',
            text: "Points are awarded when someone you invited completes a target action — opening an employer's contact in the app for the first time.",
          },
          {
            type: 'p',
            text: 'Points may be awarded not only for people you invited directly, but also for the chain of people they invite — up to three levels deep.',
          },
          { type: 'p', text: 'Notes:' },
          {
            type: 'ul',
            items: [
              'Exact rates (how many points, for which level of the chain) may change from time to time — current numbers are always shown in the app.',
              'Crediting may not be instant — sometimes it takes time to confirm an action is genuine.',
              'We may set limits (for example, on points per day, or on how many invites count).',
              'If we detect signs of manipulation or rule violations, we may withhold points or cancel (annul) points already credited — without any compensation.',
            ],
          },
        ],
      },
      {
        heading: '4. What points do now, and in the future',
        blocks: [
          {
            type: 'p',
            text: 'Right now, points can only be accumulated — they reflect your contribution to growing the community.',
          },
          {
            type: 'p',
            text: 'In the future, we plan to introduce additional in-app bonuses redeemable with accumulated points — for example, promo codes and discounts from partners. These are preliminary plans: we do not guarantee these bonuses will appear, we set no timeline, and we may change or cancel these plans at any time.',
          },
        ],
      },
      {
        heading: '5. We may change or close the program',
        blocks: [
          {
            type: 'p',
            text: 'The organizer may, at any time, without prior notice and without explanation:',
          },
          {
            type: 'ul',
            items: [
              "change the program's rules, point rates, limits, and conditions;",
              'suspend or fully close the program;',
              'cancel points obtained in violation of the rules.',
            ],
          },
          { type: 'p', text: 'Such changes do not entitle participants to any compensation.' },
        ],
      },
      {
        heading: '6. The program is free and is not a form of earnings',
        blocks: [
          { type: 'p', text: 'Participation is free and requires no investment or purchase.' },
          {
            type: 'p',
            text: 'Points are not earnings, income, or an investment. By taking part in the program, you are not entering into any agreement with the organizer for paid work, investment, or income.',
          },
          {
            type: 'p',
            text: 'These rules do not constitute a public offer under Article 437 of the Russian Civil Code, nor a public promise of reward under Article 1055 of the Russian Civil Code — the organizer takes on no obligation to pay money or transfer property in exchange for referrals.',
          },
        ],
      },
      {
        heading: '7. What is not allowed',
        blocks: [
          { type: 'p', text: 'You may not:' },
          {
            type: 'ul',
            items: [
              'artificially inflate referrals (bots, fake or purchased accounts);',
              'invite "yourself" through other accounts;',
              'send spam in order to gain invites;',
              'otherwise attempt to deceive the counting system.',
            ],
          },
          {
            type: 'p',
            text: 'If we detect this, we may cancel points, restrict or block your participation in the program (and, for serious violations, your access to the app).',
          },
        ],
      },
      {
        heading: '8. Personal data',
        blocks: [
          {
            type: 'p',
            text: 'Running the program involves processing your personal data (who invited whom, the fact of activation). See our Privacy Policy, available in the same section of the app, for details. By participating in the program, you agree to that policy.',
          },
        ],
      },
      {
        heading: '9. Liability for employers and third parties',
        blocks: [
          {
            type: 'p',
            text: "The organizer is not responsible for the actions, job postings, or promises of employers and other third parties listed or mentioned in the app — see the app's other informational sections for more on the platform's status.",
          },
        ],
      },
      {
        heading: '10. Territory, language, and governing law',
        blocks: [
          {
            type: 'p',
            text: 'The program is available to app users regardless of country, except where participating in such a program is prohibited by the law of the country where you live — in that case, you may not participate. Rules are maintained in Russian and English; in case of discrepancy, the Russian text prevails.',
          },
          {
            type: 'p',
            text: 'Relations under the program are governed by the laws of the Russian Federation. If the law of the country where you live gives you, as a participant, more rights than this version of the rules, those rights remain yours.',
          },
          {
            type: 'p',
            text: 'Effective date of the current version: 27 July 2026. Version: 1.0. We announce rule changes in the app and/or bot; continued use of the program after changes means acceptance of the new version.',
          },
        ],
      },
      {
        heading: '11. Age of participants',
        blocks: [
          {
            type: 'p',
            text: 'Participation is open to users who are at least 18 years old. By joining the program, you confirm that you are at least 18.',
          },
        ],
      },
    ],
  },
};
