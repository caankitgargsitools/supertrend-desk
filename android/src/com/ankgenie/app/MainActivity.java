package com.ankgenie.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** AnkGenie for Android: the portal (supertrend-desk.vercel.app) full screen. Links to other sites open in the browser. */
public class MainActivity extends Activity {
  private static final String HOME = "https://supertrend-desk.vercel.app/";
  private WebView web;

  private static boolean ours(Uri u) {
    String h = u.getHost();
    return h != null && (h.equals("supertrend-desk.vercel.app") || h.endsWith(".supabase.co"));
  }

  @Override protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    web = new WebView(this);
    web.setBackgroundColor(Color.parseColor("#0a0d14"));
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setSupportZoom(false);
    s.setUserAgentString(s.getUserAgentString() + " AnkGenieApp/1.0");
    CookieManager cm = CookieManager.getInstance();
    cm.setAcceptCookie(true);
    cm.setAcceptThirdPartyCookies(web, true);
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, String url) {
        Uri u = Uri.parse(url);
        if (ours(u)) return false;
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* no app for it */ }
        return true;
      }
      @Override public void onPageFinished(WebView v, String url) { CookieManager.getInstance().flush(); }
    });
    web.setWebChromeClient(new WebChromeClient());
    setContentView(web);
    Uri start = getIntent() != null ? getIntent().getData() : null;
    if (saved != null) web.restoreState(saved);
    else web.loadUrl(start != null && ours(start) ? start.toString() : HOME);
  }

  @Override protected void onNewIntent(Intent i) {
    super.onNewIntent(i);
    Uri u = i.getData();
    if (u != null && ours(u)) web.loadUrl(u.toString());
  }

  @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

  @Override protected void onPause() { super.onPause(); CookieManager.getInstance().flush(); }

  @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
