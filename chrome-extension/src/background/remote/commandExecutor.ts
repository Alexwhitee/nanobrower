import type {
  RemoteActionResultSummary,
  RemoteCommandAction,
  RemoteCommandEnvelope,
  RemoteCommandResult,
  RemoteConfirmationRequest,
  RemoteConfirmationResponse,
  RemoteDialogPolicy,
  RemoteFileChooserPolicy,
} from '@extension/shared';
import type BrowserContext from '../browser/context';
import { createLogger } from '../log';
import { executeNativeAction } from './nativeActionExecutor';
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
  private pendingFileChooser: RemoteFileChooserPolicy | null = null;
  private pendingDialogPolicy: RemoteDialogPolicy | null = null;

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
    const { page, elementNode } = await this.getCurrentPageAndElement(elementId);
    if (page.isFileUploader(elementNode)) {
      return;
    }

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

  private async buildTabsPayload() {
    const tabs = await this.browserContext.getTabInfos();
    const currentTab = await this.browserContext.getCurrentTabInfo();
    return {
      tabs: tabs.map(tab => ({
        tab_id: tab.id,
        target_id: `tab_${tab.id}`,
        url: tab.url,
        title: tab.title,
        active: tab.id === currentTab?.id,
      })),
      active_tab_id: currentTab?.id || null,
    };
  }

  private async maybeHandleFileUpload(elementId: string): Promise<boolean> {
    if (!this.pendingFileChooser) {
      return false;
    }

    const { page, elementNode } = await this.getCurrentPageAndElement(elementId);
    const refConstraint = this.pendingFileChooser.ref || this.pendingFileChooser.input_ref || '';
    if (refConstraint && refConstraint !== elementId) {
      return false;
    }

    if (!page.isFileUploader(elementNode)) {
      return false;
    }

    await page.setFilesOnElement(elementNode, this.pendingFileChooser.paths);
    this.pendingFileChooser = null;
    return true;
  }

  private async ensureTabFocus(tabId: unknown): Promise<void> {
    if (typeof tabId === 'number' && Number.isFinite(tabId)) {
      await this.browserContext.switchTab(Math.floor(tabId));
    }
  }

  async execute(command: RemoteCommandEnvelope): Promise<RemoteCommandResult> {
    const args = (command.args || {}) as Record<string, unknown>;

    try {
      let payload: Record<string, unknown> = {};

      switch (command.action) {
        case 'get_page_state': {
          this.setLastActionResult(command.action, true, 'Collected page state');
          payload = { page_state: await this.getFreshState(command.session_id) };
          break;
        }
        case 'get_tabs': {
          this.setLastActionResult(command.action, true, 'Collected tabs');
          payload = {
            ...(await this.buildTabsPayload()),
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'open_tab': {
          const url = String(args.url || '');
          if (!url) {
            throw new Error('open_tab requires args.url');
          }
          const page = await this.browserContext.openTab(url);
          const pageState = await this.getFreshState(command.session_id);
          const tabsPayload = await this.buildTabsPayload();
          this.setLastActionResult(command.action, true, `Opened tab ${page.tabId}`);
          payload = {
            tab: tabsPayload.tabs.find(tab => tab.tab_id === page.tabId) || null,
            ...tabsPayload,
            page_state: pageState,
          };
          break;
        }
        case 'focus_tab': {
          const tabId = Number(args.tab_id);
          if (!Number.isFinite(tabId)) {
            throw new Error('focus_tab requires args.tab_id');
          }
          await this.browserContext.switchTab(Math.floor(tabId));
          const pageState = await this.getFreshState(command.session_id);
          const tabsPayload = await this.buildTabsPayload();
          this.setLastActionResult(command.action, true, `Focused tab ${tabId}`);
          payload = {
            tab: tabsPayload.tabs.find(tab => tab.tab_id === Math.floor(tabId)) || null,
            ...tabsPayload,
            page_state: pageState,
          };
          break;
        }
        case 'close_tab': {
          const tabId = Number(args.tab_id);
          if (!Number.isFinite(tabId)) {
            throw new Error('close_tab requires args.tab_id');
          }
          await this.browserContext.closeTab(Math.floor(tabId));
          this.setLastActionResult(command.action, true, `Closed tab ${tabId}`);
          payload = {
            tab_id: Math.floor(tabId),
            ...(await this.buildTabsPayload()),
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'navigate': {
          const url = String(args.url || '');
          if (!url) {
            throw new Error('navigate requires args.url');
          }
          await this.ensureTabFocus(args.tab_id);
          await this.browserContext.navigateTo(url);
          this.setLastActionResult(command.action, true, `Navigated to ${url}`);
          payload = {
            url,
            navigated: true,
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'go_back': {
          const page = await this.browserContext.getCurrentPage();
          await page.goBack();
          this.setLastActionResult(command.action, true, 'Navigated back');
          payload = {
            message: 'navigated back',
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'go_forward': {
          const page = await this.browserContext.getCurrentPage();
          await page.goForward();
          this.setLastActionResult(command.action, true, 'Navigated forward');
          payload = {
            message: 'navigated forward',
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'click': {
          const elementId = String(args.element_id || '');
          if (!elementId) {
            throw new Error('click requires args.element_id');
          }
          const uploaded = await this.maybeHandleFileUpload(elementId);
          if (!uploaded) {
            await this.maybeConfirmClick(command, elementId);
            const beforeState = await this.browserContext.getState(false, true);
            const { page, elementNode } = await this.getCurrentPageAndElement(elementId);
            await page.clickElementNode(false, elementNode);
            const afterState = await this.getFreshState(command.session_id);
            this.setLastActionResult(command.action, true, `Clicked ${elementId}`);
            payload = {
              message: `clicked ${elementId}`,
              url: afterState.url,
              navigated: beforeState.url !== afterState.url,
              page_state: afterState,
            };
          } else {
            this.setLastActionResult(command.action, true, `Uploaded files via ${elementId}`);
            payload = {
              message: `uploaded files via ${elementId}`,
              page_state: await this.getFreshState(command.session_id),
            };
          }
          break;
        }
        case 'hover': {
          const elementId = String(args.element_id || '');
          if (!elementId) {
            throw new Error('hover requires args.element_id');
          }
          const { page, elementNode } = await this.getCurrentPageAndElement(elementId);
          await page.hoverElementNode(elementNode);
          this.setLastActionResult(command.action, true, `Hovered ${elementId}`);
          payload = {
            message: `hovered ${elementId}`,
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'drag': {
          const startElementId = String(args.start_element_id || '');
          const endElementId = String(args.end_element_id || '');
          if (!startElementId || !endElementId) {
            throw new Error('drag requires args.start_element_id and args.end_element_id');
          }
          const { page, elementNode: startNode } = await this.getCurrentPageAndElement(startElementId);
          const { elementNode: endNode } = await this.getCurrentPageAndElement(endElementId);
          await page.dragBetweenElementNodes(startNode, endNode);
          this.setLastActionResult(command.action, true, `Dragged ${startElementId} -> ${endElementId}`);
          payload = {
            message: `dragged ${startElementId} -> ${endElementId}`,
            page_state: await this.getFreshState(command.session_id),
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
        case 'press_key': {
          const key = String(args.key || '').trim();
          const elementId = typeof args.element_id === 'string' ? args.element_id : '';
          if (!key) {
            throw new Error('press_key requires args.key');
          }

          const page = await this.browserContext.getCurrentPage();
          if (elementId) {
            const { elementIndex } = await this.getCurrentPageAndElement(elementId);
            await page.pressKeyOnElement(elementIndex, key);
          } else {
            await page.pressKey(key);
          }

          this.setLastActionResult(command.action, true, `Pressed ${key}${elementId ? ` on ${elementId}` : ''}`);
          payload = {
            message: `pressed ${key}${elementId ? ` on ${elementId}` : ''}`,
            key,
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
          const page = await this.browserContext.getCurrentPage();
          const elementId = typeof args.element_id === 'string' ? args.element_id : '';
          const elementNode = elementId ? (await this.getCurrentPageAndElement(elementId)).elementNode : undefined;
          const direction = typeof args.direction === 'string' ? args.direction : '';
          const text = typeof args.text === 'string' ? args.text : '';
          const nth = Number(args.nth ?? 1);

          if (text) {
            const matched = await page.scrollToText(text, Number.isFinite(nth) ? nth : 1);
            this.setLastActionResult(command.action, matched, matched ? `Scrolled to text ${text}` : `Text not found: ${text}`);
            payload = {
              message: matched ? `scrolled to text ${text}` : `text not found: ${text}`,
              page_state: await this.getFreshState(command.session_id),
            };
            break;
          }

          if (direction === 'previous_page') {
            await page.scrollToPreviousPage(elementNode);
          } else if (direction === 'next_page') {
            await page.scrollToNextPage(elementNode);
          } else if (direction === 'top') {
            await page.scrollToPercent(0, elementNode);
          } else if (direction === 'bottom') {
            await page.scrollToPercent(100, elementNode);
          } else {
            const yPercent = Number(args.y_percent ?? 65);
            await page.scrollToPercent(Number.isFinite(yPercent) ? yPercent : 65, elementNode);
          }

          this.setLastActionResult(command.action, true, 'Scrolled');
          payload = {
            message: 'scrolled',
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'wait_for': {
          const timeoutMs = Number(args.timeout_ms ?? 3000);
          const pollIntervalMs = Number(args.poll_interval_ms ?? 300);
          const expectedText = typeof args.text === 'string' ? args.text.trim() : '';
          const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
          const expectedUrl = typeof args.url === 'string' ? args.url.trim() : '';
          const loadState = typeof args.load_state === 'string' ? args.load_state.trim() : '';
          const fn = typeof args.fn === 'string' ? args.fn.trim() : '';
          const timeMs = Number(args.time_ms ?? NaN);
          const page = await this.browserContext.getCurrentPage();

          if (selector) {
            await page.waitForSelector(selector, timeoutMs);
          } else if (expectedUrl) {
            await page.waitForUrl(expectedUrl, timeoutMs);
          } else if (loadState) {
            await page.waitForLoadState(loadState, timeoutMs);
          } else if (fn) {
            await page.waitForFunction(fn, timeoutMs);
          } else if (Number.isFinite(timeMs) && timeMs >= 0) {
            await new Promise(resolve => setTimeout(resolve, timeMs));
          } else {
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
          }

          this.setLastActionResult(command.action, true, 'Wait complete');
          payload = {
            message: 'wait complete',
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'extract_text': {
          const elementId = typeof args.element_id === 'string' ? args.element_id : '';
          const mode = typeof args.mode === 'string' ? args.mode : 'summary';
          const selector = typeof args.selector === 'string' ? args.selector : undefined;
          if (elementId) {
            const { elementNode } = await this.getCurrentPageAndElement(elementId);
            const text = elementNode.getAllTextTillNextClickableElement(3);
            this.setLastActionResult(command.action, true, `Extracted text from ${elementId}`);
            payload = {
              text,
              page_state: await this.getFreshState(command.session_id),
            };
          } else if (mode === 'readability') {
            const page = await this.browserContext.getCurrentPage();
            const readability = await page.getReadabilityContent();
            this.setLastActionResult(command.action, true, 'Extracted readability content');
            payload = {
              text: readability.textContent,
              readability,
              page_state: await this.getFreshState(command.session_id),
            };
          } else if (mode === 'markdown') {
            const page = await this.browserContext.getCurrentPage();
            const text = await page.getMarkdownContent(selector);
            this.setLastActionResult(command.action, true, 'Extracted markdown content');
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
        case 'evaluate_script': {
          const fn = typeof args.fn === 'string' ? args.fn.trim() : '';
          if (!fn) {
            throw new Error('evaluate_script requires args.fn');
          }
          const page = await this.browserContext.getCurrentPage();
          const value = await page.evaluateScript(fn);
          this.setLastActionResult(command.action, true, 'Evaluated script');
          payload = {
            result: {
              value,
              json: (() => {
                try {
                  return JSON.stringify(value);
                } catch {
                  return undefined;
                }
              })(),
            },
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'console_messages': {
          const page = await this.browserContext.getCurrentPage();
          const level = typeof args.level === 'string' ? args.level : undefined;
          const limit = typeof args.limit === 'number' ? args.limit : undefined;
          const messages = page.getConsoleMessages(level, limit);
          this.setLastActionResult(command.action, true, `Collected ${messages.length} console messages`);
          payload = {
            messages,
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'save_pdf': {
          const page = await this.browserContext.getCurrentPage();
          const pdf = await page.printToPdf();
          this.setLastActionResult(command.action, true, 'Saved PDF');
          payload = {
            pdf,
            file_name: `page-${Date.now()}.pdf`,
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'arm_file_chooser': {
          const paths = Array.isArray(args.paths) ? args.paths.map(item => String(item)) : [];
          if (!paths.length) {
            throw new Error('arm_file_chooser requires args.paths');
          }
          this.pendingFileChooser = {
            paths,
            ref: typeof args.ref === 'string' ? args.ref : undefined,
            input_ref: typeof args.input_ref === 'string' ? args.input_ref : undefined,
            element: typeof args.element === 'string' ? args.element : undefined,
          };
          this.setLastActionResult(command.action, true, 'Armed file chooser');
          payload = {
            armed: true,
            policy: this.pendingFileChooser,
          };
          break;
        }
        case 'arm_dialog': {
          const page = await this.browserContext.getCurrentPage();
          this.pendingDialogPolicy = {
            accept: Boolean(args.accept),
            prompt_text: typeof args.prompt_text === 'string' ? args.prompt_text : undefined,
          };
          page.armNextDialog(this.pendingDialogPolicy.accept, this.pendingDialogPolicy.prompt_text);
          this.setLastActionResult(command.action, true, 'Armed dialog policy');
          payload = {
            armed: true,
            policy: this.pendingDialogPolicy,
          };
          break;
        }
        case 'resize_window': {
          const width = Number(args.width);
          const height = Number(args.height);
          if (!Number.isFinite(width) || !Number.isFinite(height)) {
            throw new Error('resize_window requires args.width and args.height');
          }
          await this.browserContext.resizeCurrentWindow(width, height);
          this.setLastActionResult(command.action, true, `Resized window to ${width}x${height}`);
          payload = {
            width,
            height,
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'screenshot': {
          const page = await this.browserContext.getCurrentPage();
          const elementId = typeof args.element_id === 'string' ? args.element_id : '';
          const fullPage = Boolean(args.full_page);
          const screenshot = elementId
            ? await page.takeElementScreenshot((await this.getCurrentPageAndElement(elementId)).elementNode)
            : await page.takeScreenshot(fullPage);
          this.lastScreenshotRef = `shot_${Date.now()}`;
          this.setLastActionResult(command.action, true, 'Captured screenshot');
          payload = {
            screenshot_ref: this.lastScreenshotRef,
            screenshot,
            image_type: 'jpeg',
            page_state: await this.getFreshState(command.session_id),
          };
          break;
        }
        case 'native_action': {
          const action = String(args.action || '').trim();
          if (!action) {
            throw new Error('native_action requires args.action');
          }
          this.setLastActionResult(command.action, true, `Executing native action ${action}`);
          payload = await executeNativeAction(
            this.browserContext,
            action as Parameters<typeof executeNativeAction>[1],
            (args.params as Record<string, unknown> | undefined) || {},
            command.session_id,
            {
              action: 'native_action',
              ok: true,
              message: `Executed native action ${action}`,
            },
            this.lastScreenshotRef,
          );
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
