<script lang="ts">
	// /early-access — public (no sign-in; routes/+layout.svelte renders it bare). The short notice that
	// stands in for full legal documents during early access; see $lib/early-access/notice.ts.
	import { locale } from '$lib/stores/locale.svelte';
	import { CONTACT_EMAIL, EARLY_ACCESS_NOTICE, noticeLanguageFor } from '$lib/early-access/notice';

	const language = $derived(noticeLanguageFor(locale.current));
	const notice = $derived(EARLY_ACCESS_NOTICE[language]);
</script>

<svelte:head>
	<title>{notice.title}</title>
</svelte:head>

<main class="ea-page" lang={language} dir="ltr">
	<!-- A full page load: this page skipped Keycloak, and the app needs it. -->
	<a class="ea-back" href="/" data-sveltekit-reload>{notice.back}</a>
	<h1>{notice.title}</h1>
	{#each notice.paragraphs as p (p)}
		<p>{p}</p>
	{/each}
	<p>{notice.contactLabel} <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>
</main>

<style>
	.ea-page {
		max-width: 640px;
		margin: 0 auto;
		padding: 32px 16px 48px;
		color: var(--c-ink);
		background: var(--c-white, #fff);
		min-height: 100vh;
	}
	.ea-back {
		display: inline-block;
		margin-bottom: 24px;
		font-size: 13px;
		font-weight: 600;
		color: var(--c-teal-dark);
		text-decoration: none;
	}
	h1 {
		font-family: var(--font-display);
		font-size: 26px;
		color: var(--c-midnight);
		margin: 0 0 16px;
	}
	p {
		font-size: 15px;
		line-height: 1.65;
		margin: 0 0 12px;
	}
	a {
		color: var(--c-teal-dark);
	}
</style>
