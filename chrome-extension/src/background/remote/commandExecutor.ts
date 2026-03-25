import type {
  RemoteActionResultSummary,
  RemoteCommandAction,
  RemoteCommandEnvelope,
  RemoteCommandResult,
  RemoteConfirmationRequest,
  RemoteConfirmationResponse,
} from '@extension/shared';
import type BrowserContext from '../browser/context';
import { createLogger } from '../log';
import { buildRemotePageState, parseRemoteElementId } from './pageState';

const logger = createLogger('RemoteCommandExecutor');

const SENSITIVE_TEXT_PATTERNS = /(提交|删除|发送|下单|支付|购买|确认|submit|delete|send|order|pay|purchase|confirm)/i;

interface ExecutorOptions {
  requestConfirmation: (request: RemoteConfirmationRequest) => Promise<RemoteConfirmationResponse['decision']>;
}

export class RemoteCommandExecutor {
  private readonly browserContext: BrowserContext;
  private readonly requestConfirmation: ExecutorOptions['requestConfirmation'];
  private lastActionResult: RemoteActionResultSummary | null = null;
  private lastScreenshotRef: string | null = null;

  constructor(browserContext: BrowserContext, options: ExecutorOptions) {
    this.browserContext = browserContext;
    this.requestConfirmation = options.requestConfirmation;
  }

  private setLastActionResult(action: RemoteCommandAction, ok: boolean, message: string): void {
    this.lastActionResult = {
      action,
      ok,
      message,
    };
  }

  private async getFreshState(sessionId: string) {
    const browserState = await this.browserContext.getState(false, true);
    return buildRemotePageState(browserState, sessionId, this.lastActionResult, this.lastScreenshotRef);
  }

  private async getCurrentPageAndElement(elementId: string) {
    await this.browserContext.getState(false, true);
    const page = await this.browserContext.getCurrentPage();
    const elementIndex = parseRemoteElementId(elementId);
    const elementNode = page.getDomElementByIndex(elementIndex);

    if (!elementNode) {
      throw new Error(`Element not found for element_id=${elementId}`);
    }

    return { page, elementIndex, elementNode };
  }

  private async maybeConfirmClick(command: RemoteCommandEnvelope, elementId: string): Promise<void> {
    const { elementNode } = await this.getCurrentPageAndElement(elementId);
    const elementText = elementNode.getAllTextTillNextClickableElement(2) || elementNode.attributes.value || '';

    if (!SENSITIVE_TEXT_PATTERNS.test(elementText)) {
      return;
    }

    const confirmation: RemoteConfirmationRequest = {
      confirmation_id: `confirm_${command.command_id}`,
      session_id: command.session_id,
      command_id: command.command_id,
      action: command.action,
      title: 'Sensitive browser action',
      message: `Allow clicking "${elementText.trim() || elementId}" on the local browser?`,
      confirm_label: 'Allow once',
      reject_label: 'Reject',
      stop_label: 'Stop task',
    };

    const decision = await this.requestConfirmation(confirmation);
    if (decision === 'approve') {
      return;
    }

    if (decision === 'stop') {
      throw new Error('User stopped the remote session');
    }

    throw new Error('User rejected the remote action');
  }

  async execute(command: RemoteCommandEnvelope): Promise<RemoteCommandResult> {
    const args = command.args || {};

    try {
      let payload: Record<string, unknown> = {};

      switch (command.action) {
        case 'get_page_state': {
          this.setLastActionResult(command.action, true, 'Collected page state');
          payload = { page_state: await this.getFreshState(command.session_id) };
          break;
        }
        case 'navigate': {
          const url = String(args.url || '');
          if (!url) {
            throw new Error('navigate requires args.url');
          }
          await this.browserContext.navigateTo(url);
          this.setLastActionResult(command.action, true, `Navigated to ${url}`);
          payload = {
            url,
            navigated: true,
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'click': {
          const elementId = String(args.element_id || '');
          if (!elementId) {
            throw new Error('click requires args.element_id');
          }
          await this.maybeConfirmClick(command, elementId);
          const beforeState = await this.browserContext.getState(false, true);
          const { page, elementNode } = await this.getCurrentPageAndElement(elementId);
          await page.clickElementNode(false, elementNode);
          this.setLastActionResult(command.action, true, `Clicked ${elementId}`);
          const afterState = await this.getFreshState(command.session_id);
          payload = {
            message: `clicked ${elementId}`,
            url: afterState.url,
            navigated: beforeState.url !== afterState.url,
            page_state: afterState,
          };
          break;
        }
        case 'type': {
          const elementId = String(args.element_id || '');
          const text = String(args.text || '');
          if (!elementId || !text) {
            throw new Error('type requires args.element_id and args.text');
          }
          const { page, elementIndex, elementNode } = await this.getCurrentPageAndElement(elementId);
          await page.inputTextElementNode(false, elementNode, text);
          const handle = await page.getElementByIndex(elementIndex);
          const typedValue = await handle?.evaluate(el => {
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              return el.value;
            }
            if (el instanceof HTMLElement) {
              return el.textContent || '';
            }
            return '';
          });
          if (typeof typedValue !== 'string' || !typedValue.includes(text)) {
            throw new Error(`Typed value verification failed for ${elementId}`);
          }
          this.setLastActionResult(command.action, true, `Typed into ${elementId}`);
          payload = {
            message: `typed into ${elementId}`,
            value: typedValue,
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'select_option': {
          const elementId = String(args.element_id || '');
          const text = String(args.text || '');
          if (!elementId || !text) {
            throw new Error('select_option requires args.element_id and args.text');
          }
          const { page, elementIndex } = await this.getCurrentPageAndElement(elementId);
          const message = await page.selectDropdownOption(elementIndex, text);
          this.setLastActionResult(command.action, true, message);
          payload = {
            message,
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'scroll': {
          const yPercent = Number(args.y_percent ?? 65);
          const elementId = typeof args.element_id === 'string' ? args.element_id : null;
          const page = await this.browserContext.getCurrentPage();
          if (elementId) {
            const { elementNode } = await this.getCurrentPageAndElement(elementId);
            await page.scrollToPercent(yPercent, elementNode);
          } else {
            await page.scrollToPercent(yPercent);
          }
          this.setLastActionResult(command.action, true, `Scrolled to ${yPercent}%`);
          payload = {
            message: `scrolled to ${yPercent}%`,
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'wait_for': {
          const timeoutMs = Number(args.timeout_ms ?? 3000);
          const pollIntervalMs = Number(args.poll_interval_ms ?? 300);
          const expectedText = typeof args.text === 'string' ? args.text : '';
          const deadline = Date.now() + timeoutMs;
          let matched = expectedText === '';
          let latestState = await this.getFreshState(command.session_id);

          while (Date.now() < deadline) {
            if (!expectedText || latestState.page_text_summary.includes(expectedText)) {
              matched = true;
              break;
            }
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            latestState = await this.getFreshState(command.session_id);
          }

          if (!matched) {
            throw new Error(`Timed out waiting for text "${expectedText}"`);
          }
          this.setLastActionResult(command.action, true, expectedText ? `Matched "${expectedText}"` : 'Wait complete');
          payload = {
            message: expectedText ? `matched ${expectedText}` : 'wait complete',
            page_state: latestState,
          };
          break;
        }
        case 'extract_text': {
          const elementId = typeof args.element_id === 'string' ? args.element_id : '';
          if (elementId) {
            const { elementNode } = await this.getCurrentPageAndElement(elementId);
            const text = elementNode.getAllTextTillNextClickableElement(3);
            this.setLastActionResult(command.action, true, `Extracted text from ${elementId}`);
            payload = {
              text,
              page_state: await this.getFreshState(command.session_id),
            };
          } else {
            const state = await this.getFreshState(command.session_id);
            this.setLastActionResult(command.action, true, 'Extracted page text');
            payload = {
              text: state.page_text_summary,
              page_state: state,
            };
          }
          break;
        }
        case 'screenshot': {
          const page = await this.browserContext.getCurrentPage();
          const screenshot = await page.takeScreenshot();
          this.lastScreenshotRef = `shot_${Date.now()}`;
          this.setLastActionResult(command.action, true, 'Captured screenshot');
          payload = {
            screenshot_ref: this.lastScreenshotRef,
            screenshot,
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'stop_session': {
          this.setLastActionResult(command.action, true, 'Session stopped');
          payload = { stopped: true };
          break;
        }
        default:
          throw new Error(`Unsupported remote action: ${command.action}`);
      }

      return {
        command_id: command.command_id,
        session_id: command.session_id,
        ok: true,
        payload,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Remote command failed [${command.action}]`, errorMessage);
      this.setLastActionResult(command.action, false, errorMessage);
      return {
        command_id: command.command_id,
        session_id: command.session_id,
        ok: false,
        error: errorMessage,
      };
    }
  }
}
