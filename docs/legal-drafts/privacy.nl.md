# Privacyverklaring CommonPractice

**Versie:** 1.0 (early access)
**Ingangsdatum:** 2026-10-16
**Contact:** george@nonagentic.ai

*Deze verklaring is beschikbaar in het Engels en het Nederlands. Bij strijdigheid tussen beide versies prevaleert de Engelse versie.*

## 1. Wie is verantwoordelijk

1.1 Deze verklaring legt uit hoe [[ENTITY_NAME]], handelend onder de naam nonagentic.ai, KvK-nummer [[KVK_NUMBER]], [[REGISTERED_ADDRESS]] ("**nonagentic.ai**", "**wij**"), persoonsgegevens verwerkt in verband met CommonPractice op https://commonpractice-app.nonagentic.ai (de "**Dienst**"). Zij wordt verstrekt op grond van de artikelen 13 en 14 van de Algemene verordening gegevensbescherming (EU) 2016/679 ("**AVG**").

1.2 Contact voor alle privacyvragen en -verzoeken: george@nonagentic.ai. nonagentic.ai heeft geen functionaris voor gegevensbescherming aangesteld [[DPO_STATUS]].

## 2. Twee rollen: verwerkingsverantwoordelijke en verwerker

2.1 **nonagentic.ai als verwerker.** De Dienst wordt gebruikt door organisaties ("**Klanten**"). Voor klantcontent — datasets, flows, opmerkingen, stemmen, prompts aan en antwoorden van de bouwassistent, en de accounts van leden die de Klant uitnodigt — is de Klant de verwerkingsverantwoordelijke en verwerkt nonagentic.ai de gegevens namens de Klant als verwerker (artikel 28 AVG). Voor die verwerking **geldt de privacyverklaring van uw organisatie** en richt u verzoeken aan uw organisatie. nonagentic.ai stuurt verzoeken die zij ontvangt door aan de betreffende Klant.

2.2 **nonagentic.ai als verwerkingsverantwoordelijke.** nonagentic.ai is verwerkingsverantwoordelijke voor haar eigen doeleinden: het beheer van het account van de beheerderscontactpersoon van elke Klant, beveiligingslogs, de afhandeling van aanmeldingsverzoeken en uitnodigingen, en verbetering van de dienst uitsluitend met geaggregeerde gegevens. Deze verklaring gaat over die verwerking.

## 3. Wat wij verwerken, waarom, op welke grondslag en hoe lang

| Doel | Persoonsgegevens | Rechtsgrond | Bewaartermijn |
|---|---|---|---|
| Afhandelen van aanmeldingsverzoeken voor early access en beoordelen of een organisatie wordt toegelaten | E-mailadres, naam, bedrijf, optionele toelichting | Gerechtvaardigd belang (art. 6 lid 1 sub f AVG): beslissen welke organisaties tijdens de early access op uitnodiging worden toegelaten | [[SIGNUP_REQUEST_RETENTION]] als er geen account volgt; anders als bij accountbeheer |
| Versturen van uitnodigingen en account-e-mails | E-mailadres van de genodigde; naam indien opgegeven | Uitvoering van de overeenkomst met de Klant (art. 6 lid 1 sub b) voor de beheerderscontactpersoon; gerechtvaardigd belang (art. 6 lid 1 sub f) voor andere genodigden, voor zover nodig om de door hun organisatie gevraagde toegang te leveren | Gedurende de overeenkomst met de Klant, daarna verwijderd zoals in artikel 3.3 |
| Accountbeheer van de beheerderscontactpersoon van de Klant | E-mailadres, naam, inlog-ID, taalinstelling, rol, organisatie | Uitvoering van de overeenkomst (art. 6 lid 1 sub b), of gerechtvaardigd belang (art. 6 lid 1 sub f) waar de beheerder als vertegenwoordiger van de Klant optreedt | Gedurende de overeenkomst, daarna verwijderd zoals in artikel 3.3 |
| Beveiliging, rate limiting en misbruikpreventie, ook bij aanmelding | IP-adres, client-host in databaselogs, auditlog (actor, actie, metadata), applicatielogs, botcontrole bij aanmelding | Gerechtvaardigd belang (art. 6 lid 1 sub f): bescherming van de Dienst, de Klanten en hun gegevens | Applicatielogs 24 uur; metrics 2 dagen; databaselogs circa 10 weken; auditlog zoals in artikel 3.3 |
| Verbetering van de dienst op geaggregeerd niveau | Gebruiksmeting: aantallen tokens en kosten (geen prompttekst), geaggregeerd gebruik | Gerechtvaardigd belang (art. 6 lid 1 sub f): exploiteren en verbeteren van de Dienst | Alleen gebruikt in geaggregeerde vorm die geen personen identificeert |
| Naleving van wettelijke verplichtingen | Gegevens die de wet vereist (bijvoorbeeld fiscale of administratieve gegevens, antwoorden op rechtmatige bevelen) | Wettelijke verplichting (art. 6 lid 1 sub c) | Zolang de wet vereist |

3.1 Waar wij ons op een gerechtvaardigd belang baseren, hebben wij dat belang afgewogen tegen uw rechten. U kunt bezwaar maken (artikel 7).

3.2 Wij verwerken voor onze eigen doeleinden geen bijzondere categorieën van persoonsgegevens.

3.3 Na afloop van de overeenkomst van een Klant kan de Klant zijn gegevens binnen 30 dagen exporteren. Daarna verwijderen wij klantcontent en persoonsgegevens binnen 30 dagen, behalve waar bewaring wettelijk verplicht is. Back-ups worden binnen 14 dagen na verwijdering uitgefaseerd. Nachtelijke back-ups van de database worden 14 dagen bewaard.

3.4 **Herkomst (artikel 14 AVG).** Als u de gegevens niet zelf heeft verstrekt, hebben wij ze ontvangen van uw organisatie (bijvoorbeeld wanneer een beheerder u uitnodigt), of zijn ze ontstaan door uw gebruik van de Dienst (logs, auditregels, gebruiksmeting).

## 4. Ontvangers en subverwerkers

4.1 Wij maken gebruik van de volgende dienstverleners:

| Dienstverlener | Rol | Locatie | Waarborg voor doorgifte |
|---|---|---|---|
| STRATO / IONOS SE | Hosting van de applicatie, database en identiteitsdienst op dedicated servers | Duitsland (Berlijn en Frankfurt) | Binnen de EU |
| Cloudflare, Inc. | DNS, TLS-terminatie, netwerkbescherming, botbescherming (Turnstile) bij aanmelding | VS / wereldwijd edge-netwerk | EU-VS Data Privacy Framework en modelcontractbepalingen |
| Google LLC | Bezorging van uitnodigingen en account-e-mails via Gmail (afzender nonagenticai@gmail.com) | VS | EU-VS Data Privacy Framework en modelcontractbepalingen |

4.2 Het taalmodel achter de AI-functies draait op eigen hardware van nonagentic.ai in Nederland. Nachtelijke back-ups worden opgeslagen op een eigen server van nonagentic.ai in Nederland. Standaard ontvangt geen externe AI-aanbieder gegevens.

4.3 **Optioneel, gekozen door uw organisatie:**
a. **Microsoft**, alleen als uw organisatie inloggen met een Microsoft-werkaccount inschakelt;
b. **Commerciële AI-aanbieders** (bijvoorbeeld OpenAI, Anthropic, Cohere, DeepSeek, xAI, OpenRouter), alleen als uw organisatie een eigen API-sleutel instelt. Die aanbieder wordt dan door uw organisatie ingeschakeld onder haar eigen overeenkomst, en gegevens worden op instructie van uw organisatie daarheen verzonden. De privacyverklaring van uw organisatie behoort dit te beschrijven.

4.4 Wij kunnen gegevens aan autoriteiten verstrekken als wij daartoe wettelijk verplicht zijn.

4.5 Wij informeren Klanten 30 dagen voordat wij een subverwerker toevoegen of vervangen, met een recht van bezwaar.

## 5. Doorgifte buiten de EER

5.1 Cloudflare en Google zijn gevestigd in de Verenigde Staten. Doorgifte aan hen berust op het EU-VS Data Privacy Framework (adequaatheidsbesluit van de Europese Commissie van 10 juli 2023) en daarnaast op de modelcontractbepalingen (Uitvoeringsbesluit (EU) 2021/914 van de Commissie). Het wereldwijde edge-netwerk van Cloudflare kan verkeer verwerken op locaties dicht bij de gebruiker. U kunt een kopie van de betreffende waarborgen opvragen via george@nonagentic.ai.

## 6. Beveiliging

6.1 De maatregelen omvatten TLS voor al het verkeer, versleutelde databaseverbindingen, scheiding tussen organisaties in de database, rolgebaseerde toegang, automatische maskering van persoonsgegevens voor niet-bevoorrechte gebruikers, testruns in een sandbox, versleutelde opslag van API-sleutels van klanten, een auditlog, monitoring, nachtelijke back-ups met een automatische hersteltest en beperkte beheerderstoegang. De Verwerkersovereenkomst (Bijlage II) bevat de volledige lijst.

## 7. Uw rechten

7.1 Op grond van de AVG heeft u het recht op:
a. inzage in uw persoonsgegevens (art. 15);
b. rectificatie van onjuiste gegevens (art. 16);
c. gegevenswissing (art. 17);
d. beperking van de verwerking (art. 18);
e. overdraagbaarheid van gegevens (art. 20);
f. bezwaar tegen verwerking op basis van gerechtvaardigd belang (art. 21);
g. intrekking van toestemming op elk moment, waar de verwerking op toestemming berust, zonder dat dit eerdere verwerking aantast (art. 7 lid 3). Voor de doeleinden in artikel 3 baseren wij ons momenteel niet op toestemming.

7.2 Stuur verzoeken naar george@nonagentic.ai, of, voor gegevens waarvoor uw organisatie verantwoordelijk is, naar de beheerder van uw organisatie. Wij reageren binnen één maand (art. 12 lid 3), te verlengen met twee maanden bij complexe verzoeken. Wij kunnen uw identiteit moeten verifiëren.

7.3 U heeft het recht een klacht in te dienen bij de Autoriteit Persoonsgegevens (https://autoriteitpersoonsgegevens.nl), of bij de toezichthoudende autoriteit in het EU-land waar u woont of werkt.

## 8. Bent u verplicht gegevens te verstrekken?

8.1 Een e-mailadres en naam zijn nodig om toegang aan te vragen of een account te hebben; zonder deze gegevens kunnen wij u niet toelaten. Netwerkgegevens zoals IP-adressen worden noodzakelijkerwijs verwerkt om de Dienst veilig te leveren. Andere gegevens, zoals de toelichting bij een aanmeldingsverzoek, zijn optioneel.

## 9. Geautomatiseerde besluitvorming

9.1 Wij nemen geen besluiten die uitsluitend op geautomatiseerde verwerking berusten en die rechtsgevolgen hebben of u anderszins in aanmerkelijke mate treffen (art. 22 AVG). Het wekelijkse of periodieke stemmen over oplossingen gebeurt door menselijke leden, niet door een geautomatiseerd systeem. De bouwassistent is een AI-systeem waarmee u communiceert (artikel 50 AI-verordening); de uitvoer ervan is een voorstel dat u zelf beoordeelt, geen besluit over u.

## 10. Cookies en lokale opslag

10.1 Wanneer u inlogt, plaatst de Dienst de strikt noodzakelijke sessiecookies van de identiteitsdienst (Keycloak), die nodig zijn om u in te loggen en ingelogd te houden.

10.2 De Dienst gebruikt de lokale opslag van uw browser alleen voor voorkeuren die u instelt: taal, zijbalkweergave en de actieve organisatie.

10.3 Het openbare aanmeldformulier gebruikt Cloudflare Turnstile, een controle ter bescherming tegen bots die technische informatie op uw apparaat kan opslaan of uitlezen, uitsluitend om te verifiëren dat het verzoek niet geautomatiseerd is. Dit is strikt noodzakelijk voor de beveiliging van een dienst die u aanvraagt, is op dezelfde grond als beschreven in artikel 10.5 vrijgesteld van toestemming, en wordt niet gebruikt voor tracking of advertenties.

10.4 Wij gebruiken geen analytische, advertentie- of trackingcookies of vergelijkbare technieken.

10.5 Het opslaan van of toegang krijgen tot informatie op uw apparaat die strikt noodzakelijk is om een door u uitdrukkelijk gevraagde dienst te leveren, is vrijgesteld van toestemming op grond van artikel 5 lid 3 van de e-Privacyrichtlijn 2002/58/EG, in Nederland geïmplementeerd in artikel 11.7a van de Telecommunicatiewet. Daarom toont de Dienst geen cookiebanner.

## 11. Wijzigingen

11.1 Wij kunnen deze verklaring bijwerken. Wezenlijke wijzigingen kondigen wij per e-mail aan bij de beheerders van Klanten. De versie en ingangsdatum bovenaan geven de actuele versie aan.

## 12. Taal

12.1 Deze verklaring is beschikbaar in het Engels en het Nederlands. Bij strijdigheid prevaleert de Engelse versie.
