import {
    ActivatedRoute,
    Router,
} from '@angular/router';

import { ApiService } from '../../abstractions/api.service';
import { AuthService } from '../../abstractions/auth.service';
import { CryptoFunctionService } from '../../abstractions/cryptoFunction.service';
import { I18nService } from '../../abstractions/i18n.service';
import { PasswordGenerationService } from '../../abstractions/passwordGeneration.service';
import { PlatformUtilsService } from '../../abstractions/platformUtils.service';
import { StateService } from '../../abstractions/state.service';
import { StorageService } from '../../abstractions/storage.service';

import { ConstantsService } from '../../services/constants.service';

import { Utils } from '../../misc/utils';

import { AuthResult } from '../../models/domain/authResult';

export class SsoComponent {
    identifier: string;
    loggingIn = false;

    formPromise: Promise<AuthResult>;
    onSuccessfulLogin: () => Promise<any>;
    onSuccessfulLoginNavigate: () => Promise<any>;
    onSuccessfulLoginTwoFactorNavigate: () => Promise<any>;
    onSuccessfulLoginChangePasswordNavigate: () => Promise<any>;

    protected twoFactorRoute = '2fa';
    protected successRoute = 'lock';
    protected changePasswordRoute = 'change-password';
    protected clientId: string;
    protected redirectUri: string;
    protected state: string;
    protected codeChallenge: string;

    constructor(protected authService: AuthService, protected router: Router,
        protected i18nService: I18nService, protected route: ActivatedRoute,
        protected storageService: StorageService, protected stateService: StateService,
        protected platformUtilsService: PlatformUtilsService, protected apiService: ApiService,
        protected cryptoFunctionService: CryptoFunctionService,
        protected passwordGenerationService: PasswordGenerationService) { }

    async ngOnInit() {
        const queryParamsSub = this.route.queryParams.subscribe(async (qParams) => {
            if (qParams.code != null && qParams.state != null) {
                const codeVerifier = await this.storageService.get<string>(ConstantsService.ssoCodeVerifierKey);
                const state = await this.storageService.get<string>(ConstantsService.ssoStateKey);
                await this.storageService.remove(ConstantsService.ssoCodeVerifierKey);
                await this.storageService.remove(ConstantsService.ssoStateKey);
                if (qParams.code != null && codeVerifier != null && state != null && state === qParams.state) {
                    await this.logIn(qParams.code, codeVerifier, state);
                }
                const clientId = await this.storageService.get<string>(ConstantsService.ssoClientId);
                if (clientId === ConstantsService.browserClientId) {
                    // Prevent entering this if we're not in the web vault.
                    if (location.protocol === 'https://') {
                        window.postMessage({ type: "AUTH_RESULT", code: qParams.code, state: qParams.state }, "*");
                        this.router.navigate(['sso-complete']);
                    }
                }
            } else if (qParams.clientId != null && qParams.redirectUri != null && qParams.state != null &&
                qParams.codeChallenge != null) {
                this.redirectUri = qParams.redirectUri;
                this.state = qParams.state;
                this.codeChallenge = qParams.codeChallenge;
                this.clientId = qParams.clientId;
            }

            if (qParams.clientId == ConstantsService.browserClientId) {
                this.redirectUri = qParams.redirectUri;
                this.state = qParams.state;
                this.codeChallenge = qParams.codeChallenge;
                this.clientId = qParams.clientId;
                await this.storageService.save(ConstantsService.ssoCodeVerifierKey, qParams.codeVerifier);
                await this.storageService.save(ConstantsService.ssoStateKey, qParams.state);
                await this.storageService.save(ConstantsService.ssoClientId, this.clientId);
            }

            if (queryParamsSub != null) {
                queryParamsSub.unsubscribe();
            }
        });
    }

    async submit() {
        const passwordOptions: any = {
            type: 'password',
            length: 64,
            uppercase: true,
            lowercase: true,
            numbers: true,
            special: false,
        };
        let codeChallenge = this.codeChallenge;
        let state = this.state;
        if (codeChallenge == null) {
            const codeVerifier = await this.passwordGenerationService.generatePassword(passwordOptions);
            const codeVerifierHash = await this.cryptoFunctionService.hash(codeVerifier, 'sha256');
            codeChallenge = Utils.fromBufferToUrlB64(codeVerifierHash);
            await this.storageService.save(ConstantsService.ssoCodeVerifierKey, codeVerifier);
            await this.storageService.save(ConstantsService.ssoStateKey, state);
            await this.storageService.save(ConstantsService.ssoClientId, this.clientId);
        }
        if (state == null) {
            state = await this.passwordGenerationService.generatePassword(passwordOptions);
            await this.storageService.save(ConstantsService.ssoStateKey, state);
        }

        const authorizeUrl = this.apiService.identityBaseUrl + '/connect/authorize?' +
            'client_id=' + this.clientId + '&redirect_uri=' + encodeURIComponent(this.redirectUri) + '&' +
            'response_type=code&scope=api offline_access&' +
            'state=' + state + '&code_challenge=' + codeChallenge + '&' +
            'code_challenge_method=S256&response_mode=query&' +
            'domain_hint=' + encodeURIComponent(this.identifier);
        this.platformUtilsService.launchUri(authorizeUrl, { sameWindow: true });
    }

    private async logIn(code: string, codeVerifier: string, state: string) {
        this.loggingIn = true;

        try {
            this.formPromise = this.authService.logInSso(code, codeVerifier, this.redirectUri);
            const response = await this.formPromise;

            if (response.twoFactor) {
                this.platformUtilsService.eventTrack('SSO Logged In To Two-step');
                if (this.onSuccessfulLoginTwoFactorNavigate != null) {
                    this.onSuccessfulLoginTwoFactorNavigate();
                } else {
                    this.router.navigate([this.twoFactorRoute], {
                        queryParams: {
                            resetMasterPassword: response.resetMasterPassword,
                        },
                    });
                }
            } else if (response.resetMasterPassword) {
                this.platformUtilsService.eventTrack('SSO - routing to complete registration');
                if (this.onSuccessfulLoginChangePasswordNavigate != null) {
                    this.onSuccessfulLoginChangePasswordNavigate();
                } else {
                    this.router.navigate([this.changePasswordRoute]);
                }
            } else {
                const disableFavicon = await this.storageService.get<boolean>(ConstantsService.disableFaviconKey);
                await this.stateService.save(ConstantsService.disableFaviconKey, !!disableFavicon);
                if (this.onSuccessfulLogin != null) {
                    this.onSuccessfulLogin();
                }
                this.platformUtilsService.eventTrack('SSO Logged In');
                if (this.onSuccessfulLoginNavigate != null) {
                    this.onSuccessfulLoginNavigate();
                } else {
                    this.router.navigate([this.successRoute]);
                }
            }
        } catch { }
        this.loggingIn = false;
    }
}
