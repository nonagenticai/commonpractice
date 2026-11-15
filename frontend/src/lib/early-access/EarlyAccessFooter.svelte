<!--
  EarlyAccessFooter — one link to the public early-access notice (/early-access). Shown at the bottom of
  the app shell and on the sign-in screen.
-->
<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { EARLY_ACCESS_PATH } from './notice';
</script>

<footer class="ea-footer">
	<a href={EARLY_ACCESS_PATH}>{m.footer_early_access()}</a>
</footer>

<style>
	.ea-footer {
		display: flex;
		justify-content: center;
		padding: 18px 16px 22px;
		font-size: 12px;
	}
	.ea-footer a {
		color: var(--c-muted);
		text-decoration: none;
	}
	.ea-footer a:hover {
		color: var(--c-teal-dark);
		text-decoration: underline;
	}
</style>
