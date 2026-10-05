import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms of Service" };

export default function Terms() {
  return (
    <div className="wrap page">
      <article className="prose">
        <p className="eyebrow">Legal</p>
        <h1 style={{ fontSize: 40, margin: "10px 0 24px" }}>Terms of Service</h1>
        <p>
          Please read these Terms of Service (&quot;Terms&quot;) before using the xStockFi website and interface (the &quot;Service&quot;). By
          accessing or using the Service you agree to these Terms.
        </p>
        <h2>1. Acceptance</h2>
        <p>
          By connecting a wallet or otherwise using xStockFi you confirm that you have read and agree to these Terms and the Privacy Policy.
          If you do not agree, do not use the Service.
        </p>
        <h2>2. Eligibility</h2>
        <p>You may not use the Service if:</p>
        <ul>
          <li>you are located in, or a citizen or resident of, a jurisdiction where using it is prohibited by law or regulation;</li>
          <li>you are on a sanctions list maintained by the United States, the European Union, the United Nations or another authority;</li>
          <li>you are under 18 or under the age of majority where you live.</li>
        </ul>
        <h2>3. No advice</h2>
        <p>
          Nothing on xStockFi is financial, investment, legal or tax advice. You are solely responsible for your decisions. Options and
          binaries carry a high risk of loss and are not suitable for everyone.
        </p>
        <h2>4. Risks</h2>
        <p>Using the protocol can lose you all the funds you commit. Risks include, among others:</p>
        <ul>
          <li><b>Market risk:</b> Stock Token prices can move fast; written options can be exercised against you and bought options and stakes can expire worthless.</li>
          <li><b>Smart contract risk:</b> the contracts may contain bugs. They have not been independently audited.</li>
          <li><b>Oracle risk:</b> binaries and vault valuations depend on Chainlink price feeds, which pause outside market hours and can fail.</li>
          <li><b>Liquidity risk:</b> there may be nobody to buy your offer or take your bet.</li>
          <li><b>Third-party token risk:</b> Stock Tokens and USDG are issued by third parties that can freeze addresses or pause transfers.</li>
          <li><b>Regulatory risk:</b> the legal treatment of these products is uncertain and may change.</li>
        </ul>
        <h2>5. Stock Tokens are not shares</h2>
        <p>
          The contracts move Robinhood Stock Tokens, which track listed shares. Holding a Stock Token is not holding the share and gives no
          shareholder rights such as voting. Corporate actions are applied by the token&apos;s issuer, not by xStockFi.
        </p>
        <h2>6. The interface and the contracts</h2>
        <p>
          xStockFi provides an interface to smart contracts deployed on Robinhood Chain. The contracts run independently of this website.
          The interface may be changed, suspended or discontinued at any time without notice; the contracts, including every exit, keep
          working without it.
        </p>
        <h2>7. Prohibited use</h2>
        <ul>
          <li>Breaking any applicable law or regulation.</li>
          <li>Market manipulation or wash trading.</li>
          <li>Attempting to exploit, attack or disrupt the contracts or the interface.</li>
          <li>Acting for a sanctioned person or entity.</li>
        </ul>
        <h2>8. Intellectual property</h2>
        <p>The xStockFi name, logo and website design belong to xStockFi. The smart contracts are open source under the MIT license.</p>
        <h2>9. No warranties</h2>
        <p>
          THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED. WE DO NOT WARRANT
          THAT IT WILL BE UNINTERRUPTED, ERROR-FREE OR FREE OF HARMFUL COMPONENTS.
        </p>
        <h2>10. Limitation of liability</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, XSTOCKFI AND ITS CONTRIBUTORS ARE NOT LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
          CONSEQUENTIAL OR PUNITIVE DAMAGES, INCLUDING LOSS OF PROFITS OR FUNDS, ARISING FROM YOUR USE OF THE SERVICE.
        </p>
        <h2>11. Changes</h2>
        <p>We may update these Terms at any time. Continuing to use the Service after a change means you accept the updated Terms.</p>
        <h2>12. Contact</h2>
        <p>Questions about these Terms: reach out through our official X account.</p>
      </article>
    </div>
  );
}
